# EduAssistDesktopAPI

A Cloud Function (Firebase Functions Gen2, Node 24) that exposes a small REST API in front of the **EduAssist** Firestore project (`eduassist-b1f49`), for use by desktop companion clients (macOS/Windows) that can't easily embed Firebase's native mobile SDKs the way the main EduAssist iOS/iPadOS/macOS app does.

The main EduAssist app (Swift/SwiftUI, see the separate `EduAssistall` repo) talks to Firebase directly via the native SDK and a set of callable Cloud Functions in its own `functions/index.js`. This repo is a **separate, independently deployed codebase** that exists only for non-Apple desktop clients that need plain HTTP + JSON instead.

## Why it exists

A desktop build that isn't SwiftUI (e.g. a Windows client, or a cross-platform shell like Electron/WebView2) generally can't use the Firebase iOS SDK, and doesn't always want to pull in the full Firebase Web SDK either. `desktopApi` gives that kind of client a thin, ordinary REST surface — sign in with Firebase Auth, send the ID token as a Bearer header, get back plain JSON mirroring the same Firestore data the main app uses (`users`, `studentAdultLinks`, `learningProfiles`, `learningPaths`, `studentProgress`, `contentItems`, `conversations`).

It deliberately does **not** duplicate the AI/safety pipeline from the main app's `askCompanion` function — `/companion/messages` still returns a placeholder reply rather than calling Claude. Wiring that up is a known follow-up, not done here.

## History

This function was deployed to `eduassist-b1f49` from a different machine/checkout that no longer exists; the source lived nowhere on disk and wasn't in any git history. It was reconstructed from the live deployed bundle and hardened (see below) before this repo was created.

## Hardening

Every route except the two liveness checks now requires a valid Firebase ID token (`Authorization: Bearer <token>`) — there is no fallback to demo data or to a client-supplied `studentId`/`adultId`/`uid` query parameter. Identity is always taken from the verified token, never from the request.

`/learning-profile/:studentId` additionally checks that the caller is the student themselves, a confirmed linked adult (`studentAdultLinks`, same `{adultId}_{studentId}` doc-id convention as the main app), or an admin — the only route that returns another person's data, so it's the only one that needs an authorization check beyond "is this caller signed in."

## Routes

| Route | Auth | Notes |
|---|---|---|
| `GET /test` | none | Liveness check, returns plain text |
| `GET /integration/health` | none | Static health/status stub |
| `GET /me/link-summary` | required | Caller's own profile + their adult/student links |
| `GET /profile` | required | Caller's own `users` doc; creates one on first login |
| `GET /learning-profile/:studentId` | required + linked | A student's `learningProfiles` doc |
| `GET /learning-paths` | required | Caller's own active `learningPaths` + resolved content items |
| `GET /linked-students` | required | Students confirmed-linked to the caller, with progress |
| `GET /companion/messages` | required | Caller's own companion chat history |
| `POST /companion/messages` | required | Appends a message + placeholder reply to the caller's chat |

Ingress is still public (`ALLOW_ALL`) at the platform level — only the application layer enforces auth.

## Project layout

```
functions/
  index.js        # the function source (single Express app, exports.desktopApi)
  package.json    # Node 24, express/cors/firebase-admin/firebase-functions
firebase.json
.firebaserc       # points at the eduassist-b1f49 project
```

## Deploy

```bash
cd functions && npm install
firebase deploy --only functions:desktopApi
```
