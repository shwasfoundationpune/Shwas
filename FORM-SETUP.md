# Shwas Foundation enquiry form — activation guide

The custom form is built. It opens from either Get involved button, matches the website, and requires name, email, mobile, interest and contact consent. The message is optional. Cloudflare Turnstile verifies visitors. Enquiries go to a private Google Sheet only after server verification. No submission data is saved in the website repository.

The change is on a separate GitHub branch until the accounts below are configured. The existing live website remains available. There are no working keys in the code and no fake successful submissions. CAPTCHA reduces spam; it cannot guarantee that every enquiry is genuine.

## 1. Create the private Google Sheet

Sign in as shwasfoundation.pune@gmail.com and create a Sheet named **Shwas Foundation Enquiries**. Rename its first tab **Enquiries**.

Paste these headings into row 1 (A1 through K1):

```text
Received at (UTC)	Full name	Email	Mobile	Interested in	Message	Contact consent	Status	Assigned to	Notes	Enquiry ID
```

Keep sharing set to **Restricted**. Share only with trustees who need the records. Status starts as New; trustees can update Status, Assigned to and Notes. The other columns are supplied by the form. Do not rearrange the headings without changing the server code. Do not publish the Sheet to the web.

The Sheet ID is the part between `/d/` and `/edit` in its URL. A Sheet link is safe to provide for configuration; the Sheet remains private.

## 2. Give the submission service access to that Sheet

In https://console.cloud.google.com/ while signed in with the foundation account:

1. Create a project such as **Shwas Website Enquiries**.
2. Under **APIs & Services → Library**, enable **Google Sheets API**.
3. Under **IAM & Admin → Service Accounts**, create a service account named **shwas-enquiries**. It does not need a project-wide role.
4. Open the service account, choose **Keys → Add key → Create new key → JSON**. Save the downloaded file securely. Do not upload it to GitHub or send it in chat.
5. Copy its `client_email` address and share the enquiry Sheet with that address as **Editor**. This is the access the service needs.

The JSON credential will be pasted directly into Render's private environment settings in step 4.

## 3. Create the CAPTCHA

In https://dash.cloudflare.com/ create an account if necessary, then open **Turnstile → Add widget**.

- Name: Shwas Foundation enquiries
- Widget mode: Managed
- Allowed hostnames: `shwasfoundation.in`, `www.shwasfoundation.in`, `shwas-foundation.onrender.com`
- Save the **site key** (public) and **secret key** (private).

You do not need to move the domain from GoDaddy or change its nameservers. Only the public site key belongs in the website. Put the secret key directly into Render.

## 4. Create the small Render submission service

Keep the existing Static Site. Create an additional **New → Web Service** connected to the same `shwasfoundationpune/Shwas` repository.

| Setting | Value |
|---|---|
| Name | shwas-enquiries (or another available name) |
| Branch during setup | feature/enquiry-form |
| Runtime | Node |
| Root directory | server |
| Build command | npm install --omit=dev |
| Start command | npm start |
| Health check path | /health |

Choose the service plan yourself. A free instance may sleep and make the first submission slow; an always-on paid instance is more suitable for consistent response times. Check current Render pricing before choosing. No paid service is provisioned by this code.

Add these environment variables in Render:

| Name | Value |
|---|---|
| NODE_VERSION | 22 |
| GOOGLE_SHEET_ID | ID from step 1 |
| GOOGLE_SHEET_TAB | Enquiries |
| GOOGLE_SERVICE_ACCOUNT_JSON | Entire contents of the downloaded JSON credential, stored only here |
| TURNSTILE_SECRET_KEY | Private secret from step 3 |
| TURNSTILE_HOSTNAMES | shwasfoundation.in,www.shwasfoundation.in,shwas-foundation.onrender.com |
| ALLOWED_ORIGINS | https://shwasfoundation.in,https://www.shwasfoundation.in,https://shwas-foundation.onrender.com |

Deploy and copy the service's HTTPS address. `/health` should return `{"ok":true}`. This checks that configuration is present; a real form submission is still required to confirm Sheet access and CAPTCHA verification.

## 5. Connect and activate the website

Provide the service's HTTPS URL and public Turnstile site key. Put these in `public/form-config.js` on the feature branch. That file must never contain secrets.

Before merging, use a Render preview of the feature branch to test the form. Add the preview's exact hostname to Turnstile and `TURNSTILE_HOSTNAMES`; add its exact HTTPS origin to `ALLOWED_ORIGINS`. Remove those temporary entries after testing. Do not use production CAPTCHA credentials on localhost; Cloudflare provides special test keys for isolated local testing.

Complete one clearly labelled test enquiry with permission to store the supplied contact details. Confirm exactly one row appears with all fields. Check phone validation, required consent, CAPTCHA failure, server failure, and mobile layout. Delete the test row when finished.

Once the real integration passes, merge the pull request into main. The existing Static Site will deploy the form. Change the new Web Service branch to main as well. Google Sheet and CAPTCHA credentials remain only in the Web Service environment.

## Behaviour and operational notes

- A disabled Submit button means CAPTCHA has not passed or setup is incomplete. Email remains available.
- The server validates required fields, CAPTCHA success, exact hostname and action before writing.
- Values use Google Sheets RAW mode, preserving mobile numbers and preventing spreadsheet formulas from executing in the Sheet.
- Personal data and credentials are not logged by the application. There is no public endpoint for reading enquiries.
- A small per-email limit allows at most three verified attempts in ten minutes per server process. It resets on restart; CAPTCHA is the primary spam control.
- The app deliberately does not retry Sheet writes automatically. If the connection breaks after Google saves a row, receipt is uncertain; the visitor is asked to email before retrying to avoid duplicates.
- Keep the Sheet private, review access periodically, and remove enquiries when no longer needed. Visitors can request removal using the displayed foundation email.
- Automated backend tests use simulated Google/Cloudflare responses. They do not substitute for the final account-connected test.

## References

- https://developers.cloudflare.com/turnstile/get-started/
- https://developers.cloudflare.com/turnstile/get-started/server-side-validation/
- https://developers.google.com/identity/protocols/oauth2/service-account
- https://developers.google.com/workspace/sheets/api/guides/values
- https://render.com/docs/web-services

## Developer checks

Run `npm test` from `server/` using Node 22. There are no third-party server dependencies. The endpoint is POST `/api/enquiries`, JSON only; CORS is limited to the configured origins. The browser sends no credentials to the service except the one-time CAPTCHA response.
