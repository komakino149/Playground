# MitchWatch

> Daily office poll: Will Mitch be in tomorrow?

## Deploy to Render (free)

1. **Push to GitHub**
   - Create a new repo at github.com
   - Upload this entire folder (or `git init`, `git add .`, `git commit`, `git push`)

2. **Create a Render Web Service**
   - Go to [render.com](https://render.com) → New → Web Service
   - Connect your GitHub repo
   - Settings:
     - **Build Command:** `npm install`
     - **Start Command:** `npm start`
     - **Environment:** Node

3. **Set environment variables** (in Render dashboard → Environment):
   - `ADMIN_PASSWORD` → set this to whatever password you want

4. **Add a Persistent Disk** (important — keeps votes across restarts)
   - In Render: go to your service → Disks → Add Disk
   - Mount path: `/data`
   - Then update `DB_PATH` in server.js to `/data/mitch.db`

5. Hit **Deploy**. Your site will be live at `https://your-app.onrender.com`

## URLs
- **Main poll:** `https://your-app.onrender.com`
- **Admin panel:** `https://your-app.onrender.com/admin`

## Admin workflow (daily)
1. Go to `/admin` and log in
2. At end of day, record whether Mitch actually showed up
3. Click **Save & Archive Day** — this closes the day and resets the poll for tomorrow
4. Repeat

## Change the admin password
Set the `ADMIN_PASSWORD` environment variable in Render. Default is `mitch123` — change it before going live.

## Local development
```bash
npm install
node server.js
# → http://localhost:3000
```
