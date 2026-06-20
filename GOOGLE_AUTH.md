# Google sign-in setup

Real "Sign in with Google" — run entirely by the realtime server (your single live service), no
separate API and no database. The server does the OAuth code flow, reads your Google email/name,
and mints an app JWT with a role. Roles are assigned by email via env vars.

Flow: **Sign in with Google** → Google consent → `/auth/google/callback` → app JWT →
back to the office (`/?sso=<token>`) → click **Enter**.

---

## 1. Create a Google OAuth client (one-time, free)

1. Go to **https://console.cloud.google.com** → create a project (or pick one).
2. **APIs & Services → OAuth consent screen**:
   - User type **External** → fill app name, your support email, developer email → Save.
   - Scopes: the defaults (`openid`, `email`, `profile`) are enough — no verification needed.
   - While in **Testing** mode, only emails you add under **Test users** can sign in. To let *anyone*
     sign in, click **Publish app** (basic scopes don't require Google review).
3. **APIs & Services → Credentials → Create credentials → OAuth client ID**:
   - Application type: **Web application**.
   - **Authorized redirect URIs** — add both:
     - `https://nexspace-7inj.onrender.com/auth/google/callback`  (your live site)
     - `http://localhost:8787/auth/google/callback`  (local dev)
   - Create → copy the **Client ID** and **Client secret**.

---

## 2. Configure the server

**On Render** (your `nexspace` service → Environment), add:

```
GOOGLE_CLIENT_ID=<your-id>.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=<your-secret>
GOOGLE_OWNER_EMAILS=you@gmail.com
GOOGLE_ADMIN_EMAILS=teammate@gmail.com
JWT_SECRET=<a-long-random-string>
```

- `GOOGLE_OWNER_EMAILS` → these accounts get the **owner** role; `GOOGLE_ADMIN_EMAILS` → **admin**;
  everyone else who signs in is a **member**. (Comma-separate multiple emails.)
- **Set a strong `JWT_SECRET`** — it signs the login tokens. (Without it, a public dev default is used.)
- Redeploy after saving.

**Locally**, put the same `GOOGLE_*` / `JWT_SECRET` lines in `apps/api/.env` (the realtime server
reads them) and restart `npm start`.

---

## 3. Use it

Open the site → **Sign in with Google** → pick your account → you land back on the entry screen
("Signed in with Google") with your name filled in → **Enter**. Your role (owner/admin/member) comes
from the email mapping and unlocks the matching toolbar powers (broadcast, doors, record, moderate,
analytics, world reload).

## Notes
- The redirect URI must match **exactly** what you registered. The server derives it from the request
  host; override with `GOOGLE_REDIRECT_URI` if you use a custom domain.
- Guests still work: leave the fields blank and click Enter.
- This replaces the need for the demo email/password logins on the live site.
