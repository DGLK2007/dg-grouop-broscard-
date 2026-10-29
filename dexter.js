import express from 'express';
import multer from 'multer';
import makeWASocket, { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import pino from 'pino';
import fs from 'node:fs';
import path from 'node:path';

const app = express(), PORT = process.env.PORT || 3000;
const dir = path.resolve('temporary-images'); fs.mkdirSync(dir, { recursive: true });
const upload = multer({ dest: dir, limits: { fileSize: 8 * 1024 * 1024 }, fileFilter: (req, file, cb) => cb(null, ['image/jpeg','image/png','image/webp'].includes(file.mimetype)) });
app.use(express.json());
app.get('/', (req,res) => res.sendFile(path.resolve('index.html')));
let sock, status = 'disconnected', qr = '', code = '', logs = [], running = false;
const log = text => { logs.push(`${new Date().toLocaleTimeString()} · ${text}`); logs = logs.slice(-120); console.log(text); };
const delay = ms => new Promise(r => setTimeout(r, ms));
function cleanup() { for (const name of fs.readdirSync(dir)) { const p = path.join(dir,name); try { if (Date.now()-fs.statSync(p).mtimeMs > 7200000) fs.unlinkSync(p); } catch {} } }
cleanup(); setInterval(cleanup, 300000).unref();
async function connect() {
  status = 'connecting';
  const { state, saveCreds } = await useMultiFileAuthState('auth_info');
  const { version } = await fetchLatestBaileysVersion();
  const s = makeWASocket({version, auth: state, logger: pino({level:'silent'}), browser:['Ubuntu','Chrome','120.0.0'], printQRInTerminal:false}); sock = s;
  s.ev.on('creds.update', saveCreds);
  s.ev.on('connection.update', async u => {
    if (s !== sock) return;
    if (u.qr) { qr = await QRCode.toDataURL(u.qr); status = 'waiting'; }
    if (u.connection === 'open') { status='connected'; qr=''; code=''; log('WhatsApp connected.'); }
    if (u.connection === 'close') { status='disconnected'; qr=''; code=''; const c=u.lastDisconnect?.error?.output?.statusCode; log(`Connection closed (${c || 'unknown'}).`); if (c !== DisconnectReason.loggedOut) setTimeout(() => connect().catch(e => log(e.message)),3000); else log('Logged out. Delete auth_info and restart to pair again.'); }
  });
}
app.get('/api/status',(req,res)=>res.json({status,qr,code,logs,running}));
app.post('/api/pair',async(req,res)=>{ try { const n=String(req.body.number||'').replace(/\D/g,''); if(!/^\d{8,15}$/.test(n)) throw Error('Enter a valid international number.'); if(!sock || status==='disconnected') throw Error('Socket not ready.'); if(sock.authState.creds.registered) throw Error('Already paired.'); code=await sock.requestPairingCode(n); res.json({code}); } catch(e){res.status(400).json({error:e.message});} });
app.post('/api/send',upload.single('image'),async(req,res)=>{
  const image=req.file?.path;
  try {
    if(running) throw Error('A campaign is already running.');
    if(status!=='connected') throw Error('Connect WhatsApp first.');
    if(!image) throw Error('Choose a JPG, PNG or WebP image (max 8 MB).');
    if(req.body.consent!=='yes') throw Error('Recipient consent is required.');
    const links=String(req.body.links||'').split(/\s+/).filter(Boolean);
    if(links.length<1||links.length>2) throw Error('Enter one or two group links.');
    const codes=links.map(x=>{const m=x.match(/^https?:\/\/chat\.whatsapp\.com\/([A-Za-z0-9]+)\/?(?:\?.*)?$/); if(!m) throw Error('Invalid group link.'); return m[1];});
    const caption=String(req.body.caption||'').trim(), owner=String(req.body.owner||'').replace(/\D/g,'');
    if(!caption||caption.length>1000) throw Error('Enter a caption (max 1000 characters).');
    if(!/^\d{8,15}$/.test(owner)) throw Error('Enter a valid owner number.');
    const allowed=new Set(String(req.body.allowed||'').split(/[\s,;]+/).map(n=>n.replace(/\D/g,'')).filter(n=>/^\d{8,15}$/.test(n)));
    if(!allowed.size) throw Error('Add at least one consenting recipient number.');
    running=true; res.json({ok:true});
    (async()=>{const results=[]; try {
      const found=new Set();
      for(const c of [...new Set(codes)]) { const info=await sock.groupGetInviteInfo(c), meta=await sock.groupMetadata(info.id); log(`Group: ${meta.subject} · ${meta.participants.length} participants`); for(const p of meta.participants){const jid=p.phoneNumber||p.id; if(jid?.endsWith('@s.whatsapp.net')) found.add(jid.split('@')[0].split(':')[0]);} }
      const targets=[...found].filter(n=>allowed.has(n)); log(`Matched ${targets.length} opted-in recipients. Hidden identifiers cannot be resolved automatically.`);
      const ownerJid=`${owner}@s.whatsapp.net`;
      if(targets.length){const vcf=targets.map((n,i)=>`BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Contact ${i+1}\r\nTEL;TYPE=CELL:+${n}\r\nEND:VCARD`).join('\r\n'); await sock.sendMessage(ownerJid,{document:Buffer.from(vcf),mimetype:'text/vcard',fileName:'dexter-contacts.vcf',caption:'DEV BY DEXTER · Consenting contacts'}); log('VCF sent to owner.');}
      const bytes=fs.readFileSync(image);
      for(const n of targets){try{await sock.sendMessage(`${n}@s.whatsapp.net`,{image:bytes,caption});results.push(`${n}: SUCCESS`);log(`${n}: success`);}catch(e){results.push(`${n}: FAILED (${e.message})`);log(`${n}: failed`);} await delay(3000);}
      const ok=results.filter(x=>x.includes(': SUCCESS')).length;
      await sock.sendMessage(ownerJid,{text:`DEV BY DEXTER\n\nCampaign report\nMatched: ${targets.length}\nSent: ${ok}\nFailed: ${targets.length-ok}\n\n${results.join('\n')||'No eligible recipients found.'}`}); log('Report sent to owner.');
    }catch(e){log(`Campaign error: ${e.message}`);try{await sock.sendMessage(`${owner}@s.whatsapp.net`,{text:`DEV BY DEXTER\nCampaign stopped: ${e.message}\n\n${results.join('\n')}`});}catch{}}finally{running=false;try{fs.unlinkSync(image);}catch{}}})();
  }catch(e){if(image)try{fs.unlinkSync(image);}catch{} res.status(400).json({error:e.message});}
});
app.use((err,req,res,next)=>res.status(400).json({error:err.message}));
connect().catch(e=>log(`Connection error: ${e.message}`));
app.listen(PORT,'0.0.0.0',()=>console.log(`DEV BY DEXTER on port ${PORT}`));
