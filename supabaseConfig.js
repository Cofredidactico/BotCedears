/* ─────────────────────────── Supabase (login + admin) ───────────────────────────
 * Datos de TU proyecto Supabase (Dashboard → Project Settings → API).
 *
 *  • SUPABASE_URL      → "Project URL" (la base, SIN /rest/v1/)
 *  • SUPABASE_ANON_KEY → "anon public" key (pública por diseño; la protege RLS)
 *
 * La "anon key" es PÚBLICA: está pensada para el frontend y la protege Row Level
 * Security del lado del servidor. NO es un secreto. (Nunca pongas la service_role.)
 *
 * Los mails de ADMIN_EMAILS ven el panel de administración para aprobar usuarios;
 * tiene que coincidir con el mail admin del SQL. */

export const SUPABASE_URL = 'https://uefqcgbebmcadlulrkpc.supabase.co';
export const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVlZnFjZ2JlYm1jYWRsdWxya3BjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODUyOTQ1MDgsImV4cCI6MjEwMDg3MDUwOH0.5GiTnSqWI4ZOavhXBS48_8A0KJWF7G6cFuUVGOIifP4';
export const ADMIN_EMAILS = ['aleinver95@gmail.com'];
