# Streaming server (Cloudflare)

`worker.js` serves the Ride Display app and your ride videos from one address,
behind Cloudflare Access: only the email addresses you allow can open it.
Ride videos live in an R2 bucket (no charge for streaming them).

## Set up (once, about 15 minutes, all in the Cloudflare dashboard)

1. **Bucket.** R2 Object Storage → *Create bucket* → name `rides` → *Create bucket*.
   Leave *Public access* off.
2. **Upload a ride.** Open the bucket → *Upload* → drop in
   - the streaming copy of the ride (e.g. `RideVideo_261120_1653_Weldon_stream.mp4`, under 300 MB so the dashboard takes it),
   - `index.json`, the list of rides the app shows:
     ```json
     { "rides": [
       { "file": "RideVideo_261120_1653_Weldon_stream.mp4", "title": "Weldon Ave Roundtrip", "note": "Oakland · 9 min" }
     ] }
     ```
3. **Worker.** Workers & Pages → *Create* → *Start with Hello World* → name `rides` → *Deploy*.
   Then *Edit code*, replace everything with the contents of `worker.js`, *Deploy*.
4. **Connect the bucket.** In the Worker: *Bindings* → *Add binding* → *R2 bucket* →
   variable name `RIDES`, bucket `rides` → *Add binding* (it redeploys).
5. **Sign-in.** In the Worker: *Settings* → *Domains & Routes* → on the `workers.dev` line,
   *Enable Cloudflare Access*. Then *Manage Cloudflare Access* → edit the policy:
   *Include* → *Emails* → your address and your friend's → *Save*.
   Login method: *One-time PIN* (an emailed 6-digit code; no passwords).
   (Zero Trust may ask you once to pick a team name and the Free plan.)
6. **Try it.** Open `https://rides.<your-subdomain>.workers.dev` → enter your email →
   code from the email → the app opens. Video screen → *Clips* → **Online rides** → *Ride this*.

## Let someone in / out

Zero Trust → Access → Policies (or the Worker's *Manage Cloudflare Access*) → add or remove
their email. The free plan covers 50 people.

## Bigger files

The dashboard upload stops at 300 MB. For full-quality rides use `rclone`
(R2 → *Manage API tokens* → an Object Read & Write token; `brew install rclone`;
`rclone config` → S3 → Cloudflare) and `rclone copy RideVideo_….mp4 r2:rides`.
