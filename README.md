# Canteen pre-order (Firebase MVP)

Small **student ordering** app + **staff dashboard** with **Firestore** only. **No Firebase Authentication.**

- **Students**: username + PIN stored in Firestore (`students/{username}`). Session kept in `sessionStorage`.
- **Staff**: separate page, unlocked with a fixed **`adminPin`** in [`public/js/config.js`](public/js/config.js) (browser only).
- **Realtime**: Firestore `onSnapshot` on orders, menu, and slots.
- **Rules**: open read/write for this MVP — safe only on **trusted networks** / demos. Tighten before a public launch.

## Setup

1. Firebase project → **Firestore** (create database). **Enable** Analytics only if you want it (optional).
2. Web app config → paste into [`public/js/config.js`](public/js/config.js). Change **`adminPin`**.
3. Deploy rules (optional with open rules; still keeps console unblocked):

   ```bash
   npm install
   npx firebase login
   npm run deploy:rules
   npm run deploy:storage
   ```

4. Run locally:

   ```bash
   npx serve public
   ```

## First use

1. **Staff** → enter `adminPin` → add **menu** items and **pickup slots**.
2. **Student** → **Create account** (username + PIN ≥ 4 chars) → place an order.

## Collections

| Collection | Purpose |
|------------|---------|
| `students/{username}` | `{ pin, createdAt }` — MVP stores PIN in plain text |
| `orders` | Orders with `studentUsername`, `studentName`, item, slot, `status`, etc. |
| `menu`, `slots` | Catalog (staff-managed) |
| `meta/counters` | `orderSeq` for `#A101` style IDs |

## Scripts

- `npm run deploy:rules` — deploy [`firestore.rules`](firestore.rules)
- `npm run deploy:hosting` — deploy [`public/`](public/) to Firebase Hosting

Project default: see [`.firebaserc`](.firebaserc).
