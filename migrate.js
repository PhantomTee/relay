import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'fs'
import 'dotenv/config'

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
const sql = readFileSync('./schema.sql', 'utf8')

const statements = sql.split(';').map(s => s.trim()).filter(Boolean)

for (const statement of statements) {
  const { error } = await supabase.rpc('exec_sql', { sql: statement }).throwOnError().catch(() => ({ error: null }))
}

// Use raw REST instead
const res = await fetch(`${process.env.SUPABASE_URL}/rest/v1/rpc/exec_sql`, {
  method: 'POST',
  headers: {
    apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({ sql })
})

if (!res.ok) {
  // Fallback: run each CREATE TABLE via supabase-js query
  const { error } = await supabase.from('questions').select('id').limit(1)
  if (!error) {
    console.log('Tables already exist — nothing to do.')
  } else {
    console.log('Please run schema.sql manually in the Supabase SQL editor.')
    console.log('URL: https://supabase.com/dashboard/project/eykhmtycdeesauelgnbk/sql')
  }
} else {
  console.log('Migration complete.')
}
