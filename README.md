# UoN Smart Timetable - Secure Backend 🛡️

This is the secure Node.js service responsible for handling payments and sensitive server-side logic for the UoN Smart Timetable application.

## 🚀 Key Features

- **M-Pesa Integration**: Initiates secure STK Pushes via Lipana.
- **Server-Side Fulfillment**: Updates user credits in Firestore _only_ after verifying payment via Webhooks.
- **Security**: Uses `firebase-admin` to bypass client-side restrictions and ensure data integrity.

## 🛠️ Tech Stack

- **Runtime**: Node.js
- **Framework**: Express.js
- **Database**: Firebase Firestore (via Admin SDK)
- **Deployment**: Render (Blueprints)

## 🔑 Environment Variables

To run this server, you must set the following variables (locally in `.env` or in Render Dashboard):

| Variable                   | Description                                                       |
| :------------------------- | :---------------------------------------------------------------- |
| `LIPANA_SECRET_KEY`        | Your Live/Sandbox Secret Key from Lipana Dashboard.               |
| `FIREBASE_SERVICE_ACCOUNT` | The **entire JSON content** of your Firebase Service Account Key. |
| `LIPANA_ENV`               | `production` or `sandbox`.                                        |
| `FRONTEND_URL`             | URL of your frontend (for CORS). e.g., `https://myapp.vercel.app` |

## 🔑 How to Get Real Firebase Credentials (Exit Mock Mode)

To let the server write to Firestore, you need a **Service Account Key**:

1.  Go to the [Firebase Console](https://console.firebase.google.com/).
2.  Open **Project Settings** (Gear icon) > **Service accounts**.
3.  Click **Generate new private key**.
4.  Open the downloaded JSON file.
5.  **Minify it**: The content must be a single line string to work in `.env`.
    - _Tip_: You can use a tool like [JSON Minifier](https://jsonminify.com/) or just remove newlines.
6.  Paste it into `backend/.env`:
    ```env
    FIREBASE_SERVICE_ACCOUNT={"type":"service_account","project_id":"..."}
    ```

## 📡 API Endpoints

### 1. Initiate Payment

**POST** `/api/pay`

- **Body**: `{ "phone": "2547...", "planId": "pro", "uid": "user_123" }`
- **Action**: Triggers STK Push to user's phone.
- **Returns**: `{ "success": true, "checkoutRequestID": "..." }`

### 2. Payment Webhook

**POST** `/api/callback`

- **Body**: Lipana Callback Payload.
- **Action**: Verifies payment success and **credits the user** in Firestore.

## 🏃‍♂️ Local Development

1.  **Install Dependencies**:

    ```bash
    cd backend
    npm install
    ```

2.  **Start Server**:
    ```bash
    npm start
    ```
    Server runs on `http://localhost:5000`.

## ☁️ Deployment (Render)

This repo includes a `render.yaml` Blueprint.

1.  Connect this repo to your Render account.
2.  Render will detect the Blueprint and create a **Web Service**.
3.  **IMPORTANT**: Manually add the `LIPANA_SECRET_KEY` and `FIREBASE_SERVICE_ACCOUNT` in the Render Dashboard under **Environment**.

## 🔒 Security Architecture

- **Transport Encryption**: Render enforces **HTTPS (TLS 1.2+)** automatically for all deployed services. Traffic between the React Frontend and this Backend is fully encrypted.
- **Middleware**: Uses `helmet` to set secure HTTP headers (HSTS, X-Content-Type-Options, etc.).
- **CORS**: Configured to restrict access. Ensure `FRONTEND_URL` is set in production.
