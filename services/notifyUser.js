const { createClient } = require("@supabase/supabase-js");
const fetch = require("node-fetch");

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function notifyUser(userId, title, body) {
  try {
    const { data } = await supabaseAdmin
      .from("profiles")
      .select("push_token")
      .eq("id", userId)
      .single();

    if (!data?.push_token) {
      return;
    }

    await fetch(
      "https://exp.host/--/api/v2/push/send",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          to: data.push_token,
          sound: "default",
          title,
          body,
        }),
      }
    );
  } catch (err) {
    console.log("Push Error:", err.message);
  }
}

module.exports = notifyUser;