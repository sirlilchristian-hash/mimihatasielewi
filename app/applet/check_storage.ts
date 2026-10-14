import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import { PDFDocument } from 'pdf-lib';
dotenv.config();

const url = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || 'https://cwbcyhhqoezyobibwcdx.supabase.co';
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.VITE_SUPABASE_ANON_KEY;
const supabaseAdmin = createClient(url.replace(/\/rest\/v1\/?$/, '').replace(/\/+$/, ''), serviceKey || '', {
  auth: { persistSession: false, autoRefreshToken: false }
});

async function run() {
  console.log('Listing papers from database...');
  const { data: papers, error: pErr } = await supabaseAdmin.from('Papers').select('*');
  if (pErr) {
    console.error('DB Error:', pErr);
    return;
  }
  console.log('Found papers:', papers?.length);
  for (const p of papers || []) {
    console.log(`- ${p.unit_code} (${p.paper_title}): file_path = ${p.file_path}, price = ${p.price}`);
    if (p.file_path) {
      const { data, error } = await supabaseAdmin.storage.from('Papers').download(p.file_path);
      if (error) {
        console.log('  Storage download error for file_path:', error);
      } else if (data) {
        const ab = await data.arrayBuffer();
        const pdfDoc = await PDFDocument.load(ab, { ignoreEncryption: true });
        console.log('  Successfully downloaded. Size:', ab.byteLength, 'bytes, PageCount:', pdfDoc.getPageCount());
      }
    }
  }

  console.log('\nListing storage bucket root files...');
  const { data: rootFiles, error: rErr } = await supabaseAdmin.storage.from('Papers').list('');
  console.log('Root list:', rootFiles, rErr);

  const { data: papersFolder, error: pfErr } = await supabaseAdmin.storage.from('Papers').list('papers');
  console.log('Papers folder list:', papersFolder, pfErr);

  if (papersFolder) {
    for (const folder of papersFolder) {
      const subPath = `papers/${folder.name}`;
      const { data: subFiles } = await supabaseAdmin.storage.from('Papers').list(subPath);
      console.log(`Contents of ${subPath}:`, subFiles);
    }
  }
}

run().catch(console.error);
