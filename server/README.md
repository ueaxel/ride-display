# Streaming server (Cloudflare)

`worker.js` serves the Ride Display app and your ride videos from one address,
behind Cloudflare Access: only the email addresses you allow can open it.

- Ride videos and `index.json` live in an R2 bucket (no charge for streaming).
- `index.json` lists the rides shown under **Online rides** in the app's Ride videos dialog:

```json
{ "rides": [ { "file": "RideVideo_261120_1653_Weldon_stream.mp4", "title": "Weldon Ave Roundtrip", "note": "Oakland · 8.7 min of video" } ] }
```

Setup steps: see the instructions Claude gave (bucket → Worker → R2 binding → Access).
