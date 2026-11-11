const { createClient } = require("@supabase/supabase-js");
const fetch = require("node-fetch");

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// 🟣 =====================================================
// 🟣 NASARA EXPO PUSH NOTIFICATION HELPER
// 🟣 Android • Private Chat • Group Chat • Broadcast
// 🟣 =====================================================

async function notifyUser(userId, title, body) {
  try {
    // 🔵 1. GET RECIPIENT EXPO TOKEN

    const { data, error } = await supabaseAdmin
      .from("profiles")
      .select("push_token")
      .eq("id", userId)
      .maybeSingle();

    if (error) {
      console.error("🔴 PUSH TOKEN LOOKUP ERROR:", error);

      return {
        success: false,
        reason: "token_lookup_failed",
      };
    }

    const pushToken = data?.push_token;

    if (!pushToken) {
      console.log("⚠️ NO EXPO PUSH TOKEN:", userId);

      return {
        success: false,
        reason: "no_push_token",
      };
    }

    // 🔵 2. VERIFY EXPO TOKEN FORMAT

    if (
      typeof pushToken !== "string" ||
      !/^Expo(nent)?PushToken\[[^\]]+\]$/.test(pushToken)
    ) {
      console.error("🔴 INVALID EXPO PUSH TOKEN:", userId);

      return {
        success: false,
        reason: "invalid_push_token",
      };
    }

    // 🟢 3. SEND EXPO NOTIFICATION

    const response = await fetch(
      "https://exp.host/--/api/v2/push/send",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          to: pushToken,
          sound: "default",
          priority: "high",
          title,
          body,
          data: {
            type: "chat",
            userId,
          },
        }),
      }
    );

    // 🟡 4. READ EXPO RESPONSE

    const result = await response.json();

    console.log("📲 NASARA EXPO RESPONSE:", {
      userId,
      status: response.status,
      result,
    });

    if (!response.ok) {
      return {
        success: false,
        reason: "expo_http_error",
        status: response.status,
        result,
      };
    }

    const ticket = result?.data;

    if (ticket?.status === "error") {
      console.error("🔴 EXPO PUSH REJECTED:", ticket);

      return {
        success: false,
        reason: "expo_ticket_error",
        details: ticket,
      };
    }

    // 🟢 5. SUCCESS

    return {
      success: true,
      ticket,
    };

  } catch (err) {
    console.error("🔴 NASARA PUSH ERROR:", err);

    return {
      success: false,
      reason: "unexpected_error",
      error: err.message,
    };
  }
}

module.exports = notifyUser;