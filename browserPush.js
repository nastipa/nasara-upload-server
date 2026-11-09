// 🟣 =====================================================
// 🟣 NASARA BROWSER PUSH NOTIFICATIONS
// 🟣 Sender Profile Image • Message Preview • Chat Navigation
// 🟣 =====================================================

const webpush = require("web-push");
const { createClient } = require("@supabase/supabase-js");

// 🔵 =====================================================
// 🔵 1. INITIALIZE SUPABASE ADMIN CLIENT
// 🔵 =====================================================

if (!process.env.SUPABASE_URL) {
  throw new Error("Missing SUPABASE_URL environment variable.");
}

if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error(
    "Missing SUPABASE_SERVICE_ROLE_KEY environment variable."
  );
}

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// 🟣 =====================================================
// 🟣 2. CONFIGURE VAPID
// 🟣 =====================================================

const vapidPublicKey = process.env.VAPID_PUBLIC_KEY;
const vapidPrivateKey = process.env.VAPID_PRIVATE_KEY;
const vapidSubject = process.env.VAPID_SUBJECT;

if (!vapidPublicKey || !vapidPrivateKey || !vapidSubject) {
  throw new Error(
    "Missing VAPID environment variables. Check Render configuration."
  );
}

webpush.setVapidDetails(
  vapidSubject,
  vapidPublicKey,
  vapidPrivateKey
);

// 🟢 =====================================================
// 🟢 3. SEND BROWSER PUSH TO ONE USER
// 🟢 Supports sender image and chat navigation
// 🟢 =====================================================

async function sendBrowserPushToUser(
  userId,
  title,
  body,
  url = "/",
  options = {}
) {
  if (!userId || !title || !body) {
    throw new Error(
      "userId, title, and body are required."
    );
  }

  const {
    icon = null,
    tag = `nasara-notification-${Date.now()}`,
    room_id = null,
    image = null,
  } = options;

  const {
    data: subscriptions,
    error,
  } = await supabaseAdmin
    .from("browser_push_subscriptions")
    .select("id, subscription")
    .eq("user_id", userId);

  if (error) {
    throw new Error(
      `Could not load browser subscriptions: ${error.message}`
    );
  }

  if (!subscriptions || subscriptions.length === 0) {
    return {
      success: true,
      sent: 0,
      message: "This user has no browser subscriptions.",
    };
  }

  let sent = 0;
  let failed = 0;

  for (const record of subscriptions) {
    try {
      await webpush.sendNotification(
        record.subscription,
        JSON.stringify({
  title,
  body,
  ...(icon ? { icon } : {}),
  ...(image ? { image } : {}),
  tag,
  url,
  data: {
    url,
    room_id,
  },
})
      );

      sent++;
    } catch (error) {
      failed++;

      console.error(
        "Browser push delivery failed:",
        error.statusCode || "",
        error.message
      );

      if (
        error.statusCode === 404 ||
        error.statusCode === 410
      ) {
        const {
          error: deleteError,
        } = await supabaseAdmin
          .from("browser_push_subscriptions")
          .delete()
          .eq("id", record.id);

        if (deleteError) {
          console.error(
            "Could not delete expired subscription:",
            deleteError.message
          );
        }
      }
    }
  }

  return {
    success: failed === 0,
    sent,
    failed,
  };
}

// 🟡 =====================================================
// 🟡 4. SEND BROADCAST NOTIFICATIONS
// 🟡 Existing item notifications remain supported
// 🟡 =====================================================

async function broadcastBrowserPush(
  title,
  body,
  url = "/",
  excludeUserId = null
) {
  if (!title || !body) {
    throw new Error("title and body are required.");
  }

  let query = supabaseAdmin
    .from("browser_push_subscriptions")
    .select("id, user_id, subscription");

  if (excludeUserId) {
    query = query.neq("user_id", excludeUserId);
  }

  const {
    data: subscriptions,
    error,
  } = await query;

  if (error) {
    throw new Error(
      `Could not load browser subscriptions: ${error.message}`
    );
  }

  if (!subscriptions || subscriptions.length === 0) {
    return {
      success: true,
      sent: 0,
      failed: 0,
    };
  }

  let sent = 0;
  let failed = 0;

  for (const record of subscriptions) {
    try {
      await webpush.sendNotification(
        record.subscription,
        JSON.stringify({
          title,
          body,
          url,
          icon: "/favicon.ico",
          tag: `nasara-item-${Date.now()}`,
          data: {
            url,
          },
        })
      );

      sent++;
    } catch (error) {
      failed++;

      console.error(
        "Browser broadcast delivery failed:",
        error.statusCode || "",
        error.message
      );

      if (
        error.statusCode === 404 ||
        error.statusCode === 410
      ) {
        const {
          error: deleteError,
        } = await supabaseAdmin
          .from("browser_push_subscriptions")
          .delete()
          .eq("id", record.id);

        if (deleteError) {
          console.error(
            "Could not delete expired subscription:",
            deleteError.message
          );
        }
      }
    }
  }

  return {
    success: failed === 0,
    sent,
    failed,
  };
}

// 🔵 =====================================================
// 🔵 5. EXPORT FUNCTIONS
// 🔵 =====================================================

module.exports = {
  sendBrowserPushToUser,
  broadcastBrowserPush,
};