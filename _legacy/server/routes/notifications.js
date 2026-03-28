import { Router } from "express";
import { upsertPushSubscription, deletePushSubscription } from "../../db.js";

const router = Router();

let vapidPublicKey = null;

export function setVapidPublicKey(key) {
  vapidPublicKey = key;
}

router.get("/vapid-public-key", (req, res) => {
  if (!vapidPublicKey) {
    return res.status(404).json({ error: "Push notifications not configured" });
  }
  res.json({ key: vapidPublicKey });
});

router.post("/subscribe", (req, res) => {
  const { endpoint, keys } = req.body;
  if (!endpoint || !keys?.p256dh || !keys?.auth) {
    return res.status(400).json({ error: "Invalid subscription" });
  }
  upsertPushSubscription(endpoint, keys.p256dh, keys.auth);
  res.json({ ok: true });
});

router.post("/unsubscribe", (req, res) => {
  const { endpoint } = req.body;
  if (!endpoint) {
    return res.status(400).json({ error: "Missing endpoint" });
  }
  deletePushSubscription(endpoint);
  res.json({ ok: true });
});

export default router;
