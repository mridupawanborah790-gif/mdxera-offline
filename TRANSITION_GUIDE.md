# MDXera ERP — System Transition & Continuation Guide

This document contains everything you need to set up your development environment on a **new machine** and resume work on the MDXera ERP offline-first Tauri application.

---

## 1. Local Machine Setup & Dependencies

To build and run MDXera ERP (which is a Tauri v2 + React desktop app), the new system must have the following developer toolchains installed:

### Node.js (Frontend)
- **Required:** Node.js v20 or higher.
- **Package Manager:** npm (bundled with Node).

### Rust Toolchain (Desktop Shell)
- **Required:** Rust Compiler and Cargo package manager.
- **Installation:** Install via [rustup](https://rustup.rs/):
  ```bash
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
  ```

### OS-Specific Development Dependencies

#### macOS (if your new system is Mac)
1. Install Xcode Command Line Tools:
   ```bash
   xcode-select --install
   ```
2. Verify you can build aarch64 and x86_64 targets if you intend to cross-compile (refer to `.github/workflows/release.yml`):
   ```bash
   rustup target add aarch64-apple-darwin
   rustup target add x86_64-apple-darwin
   ```

#### Windows (if your new system is Windows)
1. Install C++ Build Tools via Visual Studio Installer (choose the "C++ build tools" workload).
2. Install [WebView2 Runtime](https://developer.microsoft.com/en-us/microsoft-edge/webview2/) (usually pre-installed on Windows 10/11).

---

## 2. Gitignored Configuration Files (CRITICAL — Backup These!)

These files are ignored by `.gitignore` and **will not** carry over via Git. You must manually copy them from your current machine to your new machine:

### A. Environment Variables (`.env.local`)
- **Location:** Project Root (`/Users/my/Office/Krittik/Temp/mdxera-offline/.env.local`)
- **Current Value:**
  ```env
  # Environment configuration for MDXera AI OCR
  VITE_OPENAI_API_KEY=your_openai_api_key_here
  VITE_AI_MODEL=gpt-4o-mini
  ```
  > [!WARNING]
  > Make sure to back up or copy this file directly. If you lose this `VITE_OPENAI_API_KEY`, your local AI OCR feature (e.g. for prescription parsing, invoice scans) will stop working unless you generate a new OpenAI token.

### B. Tauri Updater Private Key (`.updater-secrets/`)
- **Location:** `.updater-secrets/updater.key` inside the project root folder.
- **Purpose:** Signs local builds and production updates. 
  - The public key is embedded in `src-tauri/tauri.conf.json`:
    `dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDQwNjdCNDg4MEYzNTJDRDQKUldUVUxEVVBpTFJuUURxR2JQRzJZcko2SWh3MFg0NEt3WmM3OTZndkxjckh0dXoxc1lCYlplWjQK`
- **Key Password:** `mdxera-updater-key-2026`
  > [!CAUTION]
  > **DO NOT LOSE `updater.key`!** If you lose this private key, you will not be able to issue automatic updates to existing installations. Existing users would have to manually uninstall and reinstall the app, as their installed apps will reject any update signed with a different key.

---

## 3. Local Databases & Offline Cache Directories

MDXera ERP uses an offline-first SQLite database. If you want to carry over your current local database state (including local sales, inventory, profiles, or pending sync queues) to your new machine, copy the SQLite database folder:

### Database File Paths

- **macOS (Current System):**
  ```bash
  /Users/<YourUsername>/Library/Application Support/com.mdxera.erp/
  ```
  Files to copy:
  - `mdxera.db` (main SQLite database)
  - `mdxera.db-wal` (write-ahead log)
  - `mdxera.db-shm` (shared memory file)

- **Windows (if migrating to Windows):**
  ```cmd
  %APPDATA%\com.mdxera.erp\
  ```
  Copy the three `mdxera.db` files into this directory.

- **Linux (if migrating to Linux):**
  ```bash
  ~/.local/share/com.mdxera.erp/
  ```

---

## 4. Cloud Configurations & Secrets

MDXera ERP connects to a Supabase backend and triggers an Edge Function for its AI provider.

### Supabase Backend Details
- **Project URL:** `sblmbkgoiefqzykjksgm.supabase.co`
- **Database Schema & SQL scripts:** Located in the `supabase/` folder.
- **Shared DB function:** `supabase/functions/_shared/reserve_voucher_range.sql` must be deployed manually on the Supabase SQL editor.

### Supabase Edge Functions Secrets
If you need to redeploy the Edge Functions or set up a new Supabase environment, ensure the following **Secrets** are configured in the Supabase Dashboard (`Project Settings -> Edge Functions -> Secrets`):
- `GROQ_API_KEY` (Used in the `groq_ai` function for vision and text completions).
- `GROQ_DEFAULT_MODEL` (Optional override; defaults to `meta-llama/llama-4-scout-17b-16e-instruct`).

---

## 5. GitHub Repository Secrets (for CI/CD Actions)

If you are setting up a new repository or migrating GitHub accounts, make sure the following Secrets are configured in your GitHub Repo settings (`Settings -> Secrets and variables -> Actions`):

| Secret Name | Value / Description |
|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | Contents of `.updater-secrets/updater.key` |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | `mdxera-updater-key-2026` |
| `RELEASES_REPO_PAT` | Personal Access Token (PAT) with write permissions to `mridupawanborah790-gif/mdxera-software-releases` (since release builds are pushed to that repo). |

*Optional macOS notarization secrets (configured to avoid macOS Gatekeeper warning):*
- `APPLE_CERTIFICATE` (Base64-encoded Developer ID `.p12` file)
- `APPLE_CERTIFICATE_PASSWORD`
- `APPLE_SIGNING_IDENTITY` (e.g. `Developer ID Application: Your Name (TEAMID)`)
- `APPLE_ID` (Apple ID email)
- `APPLE_PASSWORD` (App-specific password)
- `APPLE_TEAM_ID` (Apple Developer Team ID)

---

## 6. Onboarding Workflow (New Machine Checklist)

Once you boot your new machine, follow these steps to resume development:

### Step 1: Clone and Restore Files
1. Clone your Git repository to the new machine.
2. Manually restore `.env.local` in the project root.
3. Manually restore `.updater-secrets/updater.key` in the project root.
4. *(Optional)* Copy the `com.mdxera.erp` data folder to the new system's app support directory to retain local offline states.

### Step 2: Install Node Dependencies
Open terminal in the project root and run:
```bash
npm install
```

### Step 3: Verify Rust Build Targets
Check that rustc is working:
```bash
cargo --version
```

### Step 4: Run the Development Server
You can develop in two modes:

- **Browser-Only Dev Mode** (Tauri functions will run as fallback no-ops):
  ```bash
  npm run dev
  ```
- **Full Desktop Shell Mode** (Launches the Tauri webview wrapper):
  ```bash
  npm run tauri:dev
  ```

---

## 7. Verification & Parity Checks

Run these commands to verify that your new development environment is operating identically to the old one:

1. **Verify TypeScript Compilation:**
   ```bash
   npx tsc --noEmit
   ```
   *Should finish with no syntax or compiler type-checking errors.*

2. **Run the Test Suite:**
   ```bash
   npm test
   ```
   *Runs the Vitest suite validating the database model, schema-drift cache, and sync adapters.*

3. **Verify Production Web Build:**
   ```bash
   npm run build
   ```

4. **Verify Desktop Release Build (Local Installer Bundle):**
   ```bash
   npm run tauri:build
   ```
   *Creates target packages under `src-tauri/target/release/bundle/`.*

---

## 8. Essential Development Reference

For a complete architectural reference, refer to the [PROJECT.md](file:///Users/my/Office/Krittik/Temp/mdxera-offline/PROJECT.md) file. It contains extensive sections on:
- The **Dual-Persistence model** (in-memory cache vs local SQLite).
- **Four directions of Sync flows** (Supabase -> SQLite, SQLite -> Cache, Cache -> Supabase direct, Cache -> SQLite Queue -> Supabase background).
- **Voucher range allocation services**.
- **Role-Based Access Controls** and User-level screen-hide visibility lockouts.
- **Common Failure modes** (blank screens, RLS security policies, duplicate material codes).

*Good luck with your system transition! If you run into issues on the new machine, run `npm test` and check the console logs inside `tauri:dev` (right-click -> Inspect element).*
