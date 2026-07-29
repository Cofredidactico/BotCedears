# Login + Administrador con Supabase — Guía de setup

Esto activa el **acceso con login por email** (link mágico) y un **panel de administrador** para aprobar/rechazar usuarios. Todo gratis con el free tier de Supabase.

> **Importante:** mientras `supabaseConfig.js` esté vacío, la app funciona igual que siempre, **sin login**. Recién cuando pegás las 2 claves (paso 4) se activa el portón. Así podés preparar todo con calma sin romper nada.

---

## 1) Crear el proyecto (5 min)

1. Entrá a **https://supabase.com** → **Start your project** (se ingresa con GitHub o email).
2. **New project**: ponele un nombre (ej. `investment-copilot`), elegí una contraseña de base (guardala) y la región más cercana (South America / São Paulo).
3. Esperá ~2 minutos a que termine de crearse.

## 2) Habilitar el login por email (link mágico)

1. En el panel del proyecto: **Authentication** → **Providers** → **Email**.
2. Dejá **Email** habilitado. Activá **"Confirm email"** (o dejalo como viene) y asegurate de que **"Enable email OTP / Magic Link"** esté activo.
3. En **Authentication → URL Configuration**, en **Site URL** poné la URL de tu app:
   `https://bot-cedears.vercel.app` (y agregala también en *Redirect URLs*).

## 3) Crear la tabla de usuarios y las reglas (copiar-pegar)

1. En el panel: **SQL Editor** → **New query**.
2. Pegá TODO esto y tocá **Run**. (Ya viene con tu mail `aleinver95@gmail.com` como admin y auto-aprobado.)

```sql
-- Perfil por usuario: guarda si está aprobado y si es admin.
create table if not exists public.profiles (
  id uuid references auth.users on delete cascade primary key,
  email text,
  approved boolean not null default false,
  role text not null default 'user',
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

-- Al registrarse un usuario nuevo, se le crea el perfil.
-- Tu mail entra ya aprobado y como admin; el resto queda pendiente.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, approved, role)
  values (
    new.id,
    new.email,
    case when lower(new.email) = 'aleinver95@gmail.com' then true else false end,
    case when lower(new.email) = 'aleinver95@gmail.com' then 'admin' else 'user' end
  )
  on conflict (id) do nothing;
  return new;
end; $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Reglas de acceso (RLS). El admin se identifica por su mail en el token (sin recursión).
drop policy if exists "leer perfil propio" on public.profiles;
create policy "leer perfil propio" on public.profiles
  for select using (auth.uid() = id);

drop policy if exists "admin lee todo" on public.profiles;
create policy "admin lee todo" on public.profiles
  for select using (lower(auth.jwt() ->> 'email') = 'aleinver95@gmail.com');

drop policy if exists "admin actualiza todo" on public.profiles;
create policy "admin actualiza todo" on public.profiles
  for update using (lower(auth.jwt() ->> 'email') = 'aleinver95@gmail.com');
```

> Si más adelante querés otro admin, cambiá el mail en el SQL (y en `ADMIN_EMAILS` de `supabaseConfig.js`).

## 3-bis) Tabla para guardar la cartera en la nube (nuevo)

Esto es lo que hace que la cartera (y todos tus datos) queden **ligados a tu
cuenta** y sincronicen entre dispositivos: entrás desde el celular o desde otra
compu con el mismo mail y ves lo mismo. Cada usuario solo puede ver/editar lo
suyo (RLS por `auth.uid()`).

En el mismo **SQL Editor**, pegá esto y **Run** (sin las comillas ```):

```sql
-- Una fila por usuario con un JSON de todos sus datos (cartera, aportes, config…).
create table if not exists public.user_data (
  id         uuid references auth.users on delete cascade primary key,
  data       jsonb       not null default '{}',
  updated_at timestamptz not null default now()
);

alter table public.user_data enable row level security;

-- Cada quien ve, crea y actualiza SOLO su propia fila.
drop policy if exists "leer datos propios" on public.user_data;
create policy "leer datos propios" on public.user_data
  for select using (auth.uid() = id);

drop policy if exists "crear datos propios" on public.user_data;
create policy "crear datos propios" on public.user_data
  for insert with check (auth.uid() = id);

drop policy if exists "actualizar datos propios" on public.user_data;
create policy "actualizar datos propios" on public.user_data
  for update using (auth.uid() = id) with check (auth.uid() = id);
```

> No hace falta tocar nada más: `auth.js` baja tu fila al entrar y guarda sola
> cada cambio. Si esta tabla no existiera, la app igual funciona (los datos se
> quedan en el navegador) — pero sin sincronizar.

## 4) Pegar las 2 claves en la app

1. En el panel: **Project Settings** (el engranaje) → **API**.
2. Copiá:
   - **Project URL** (ej. `https://abcdxyz.supabase.co`)
   - **anon public** key (empieza con `eyJhbGciOi…`) — *es pública, va en el frontend; NO uses la `service_role`.*
3. Abrí **`supabaseConfig.js`** y completá:

```js
export const SUPABASE_URL = 'https://TU-PROYECTO.supabase.co';
export const SUPABASE_ANON_KEY = 'eyJhbGciOi...tu-anon-key...';
export const ADMIN_EMAILS = ['aleinver95@gmail.com'];
```

4. Subí `supabaseConfig.js` (y el resto de los archivos del zip) a GitHub → Vercel redeploya.

## 5) Probar

1. Entrá a la app: te recibe la **pantalla de login**. Poné tu mail → **Enviarme el link** → revisá el correo → tocás el link → entrás.
2. Como sos admin, entrás directo y ves abajo a la izquierda un chip con tu mail y el botón **⚙ Admin**.
3. Pedile a alguien que entre con su mail: le va a aparecer **"cuenta pendiente"**. Vos abrís **⚙ Admin** → lo **Aprobás** → esa persona recarga y ya puede usar la plataforma.

---

## Qué hace cada archivo

- **`supabaseConfig.js`** — tus 2 claves + lista de admins. Es lo único que tocás vos.
- **`auth.js`** — todo el login, la pantalla de "pendiente" y el panel de admin. Defensivo: si algo falla, la app sigue andando sin portón.

## Notas de seguridad

- La **anon key es pública por diseño** — lo que protege los datos son las reglas RLS de los pasos 3 y 3-bis, del lado del servidor. Aunque alguien tenga la anon key, solo puede leer/escribir **su propia** fila.
- La **cartera y tus datos viven en la nube** (tabla `user_data`), atados a tu cuenta y sincronizados entre dispositivos. El navegador guarda una copia local para andar rápido/offline, pero la fuente es tu fila en Supabase.
- **Nunca** subas la `service_role` key al frontend ni al repo: esa sí saltea RLS. La app solo usa la `anon`.
