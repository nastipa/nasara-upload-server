const express = require("express");
const multer = require("multer");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const AWS = require("aws-sdk");
const PDFDocument = require("pdfkit");
require("dotenv").config();
const hospitalRoutes = require("./routes/hospital");
const restaurantRoutes = require("./routes/restaurant");

const { createClient } = require("@supabase/supabase-js");
const fetch = require("node-fetch");
const AdmZip = require("adm-zip");
// 🟦 REEL VIDEO PROCESSING IMPORTS

const os = require("os");
const crypto = require("crypto");
const { spawn } = require("child_process");
const ffmpegPath = require("ffmpeg-static");
const notifyUser = require("./services/notifyUser");
const {
sendBrowserPushToUser,
broadcastBrowserPush,
} = require("./browserPush");
const app = express();
app.use(cors());
app.use(
  express.json({
    limit: "50mb",
  })
);

// 🔵 INTERNATIONAL PHONE NUMBER SUPPORT
const {
  parsePhoneNumberFromString,
} = require("libphonenumber-js");
/* ================= LIMIT FILE SIZE (20MB) ================= */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 150 * 1024 * 1024 },
});

/* ================= R2 CONFIG ================= */
const s3 = new AWS.S3({
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  accessKeyId: process.env.R2_ACCESS_KEY,
  secretAccessKey: process.env.R2_SECRET_KEY,
  signatureVersion: "v4",
  region: "auto",
});

/* ================= SUPABASE ADMIN ================= */
const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ============================================================
// 🔔 NASARA GENERAL ADMIN NOTIFICATION CENTRE
// Android + Browser + Supabase In-App Notifications
// ============================================================

// ------------------------------------------------------------
// 1. VERIFY NASARA ADMIN REQUEST
// ------------------------------------------------------------

async function authenticateNasaraAdminRequest(req, res) {
  try {
    const authorization =
      req.headers.authorization || "";

    if (!authorization.startsWith("Bearer ")) {
      res.status(401).json({
        success: false,
        error: "Authorization token is required.",
      });

      return null;
    }

    const accessToken = authorization
      .slice(7)
      .trim();

    if (!accessToken) {
      res.status(401).json({
        success: false,
        error: "Invalid authorization token.",
      });

      return null;
    }

    const {
      data: userData,
      error: userError,
    } = await supabaseAdmin.auth.getUser(accessToken);

    if (userError || !userData?.user) {
      res.status(401).json({
        success: false,
        error: "Invalid or expired login session.",
      });

      return null;
    }

    const user = userData.user;

    const {
      data: admin,
      error: adminError,
    } = await supabaseAdmin
      .from("admins")
      .select("user_id")
      .eq("user_id", user.id)
      .maybeSingle();

    if (adminError) {
      console.error(
        "NASARA ADMIN CHECK ERROR:",
        adminError
      );

      res.status(500).json({
        success: false,
        error: "Could not verify administrator access.",
      });

      return null;
    }

    if (!admin) {
      res.status(403).json({
        success: false,
        error: "Nasara administrator access required.",
      });

      return null;
    }

    return user;

  } catch (error) {
    console.error(
      "ADMIN AUTHENTICATION ERROR:",
      error
    );

    res.status(500).json({
      success: false,
      error: "Administrator authentication failed.",
    });

    return null;
  }
}


// ------------------------------------------------------------
// 2. CREATE GENERAL ADMIN NOTIFICATION
// ------------------------------------------------------------
// This function can be called from other backend routes
// when an important Nasara event occurs.
// ------------------------------------------------------------

async function createNasaraAdminNotification({
  type,
  title,
  body,
  ref_id = null,
  data = {},
  priority = "normal",
  sender_id = null,
}) {
  if (!type || !title || !body) {
    throw new Error(
      "Notification type, title and body are required."
    );
  }

  const allowedPriorities = [
    "low",
    "normal",
    "high",
    "urgent",
  ];

  const safePriority =
    allowedPriorities.includes(priority)
      ? priority
      : "normal";

  // Get only Nasara administrators.
  // Coalition and utility administrators are excluded.

  const {
    data: admins,
    error: adminsError,
  } = await supabaseAdmin
    .from("admins")
    .select("user_id");

  if (adminsError) {
    throw new Error(
      `Could not load Nasara administrators: ${adminsError.message}`
    );
  }

  const adminIds = [
    ...new Set(
      (admins || [])
        .map((admin) => admin.user_id)
        .filter(Boolean)
    ),
  ];

  if (adminIds.length === 0) {
    console.log(
      "No Nasara administrators found for notification."
    );

    return {
      success: true,
      recipients: 0,
      saved: 0,
      push_attempted: 0,
    };
  }

  const notificationData = {
  ...(data &&
  typeof data === "object" &&
  !Array.isArray(data)
    ? data
    : {}),
  scope: "admin",
  priority: safePriority,
  url: "/admin/notifications",
};

  // Create one in-app notification for each admin.

  const rows = adminIds.map((adminId) => ({
    user_id: adminId,
    sender_id,
    type,
    title,
    body,
    message: body,
    ref_id: ref_id ? String(ref_id) : null,
    is_read: false,
    data: notificationData,
  }));

  const {
    data: savedNotifications,
    error: saveError,
  } = await supabaseAdmin
    .from("notifications")
    .insert(rows)
    .select("id, user_id");

  if (saveError) {
    console.error(
      "ADMIN NOTIFICATION SAVE ERROR:",
      saveError
    );

    throw new Error(
      `Could not save admin notifications: ${saveError.message}`
    );
  }

  // Deliver Android and browser push independently.
  // A push failure does not delete the saved in-app alert.

  const pushResults = await Promise.allSettled(
    (savedNotifications || []).map(
      async (notification) => {
        const pushData = {
          type: "admin_notification",
          notificationId: notification.id,
          url: "/admin/notifications",
          category: type,
          priority: safePriority,
        };

        const results = await Promise.allSettled([
          notifyUser(
            notification.user_id,
            title,
            body,
            pushData
          ),

          sendBrowserPushToUser(
            notification.user_id,
            title,
            body,
            "/admin/notifications",
            {
              tag: `nasara-admin-${notification.id}`,
            }
          ),
        ]);

        return results;
      }
    )
  );

  const pushAttempted = pushResults.length;

  const pushFailed = pushResults.reduce(
  (total, result) => {
    if (result.status === "rejected") {
      return total + 2;
    }

    const deliveries = result.value || [];

    return (
      total +
      deliveries.filter(
        (delivery) =>
          delivery.status === "rejected" ||
          delivery.value?.success === false
      ).length
    );
  },
  0
);

  return {
    success: true,
    recipients: adminIds.length,
    saved: savedNotifications?.length || 0,
    push_attempted: pushAttempted,
    push_failed: pushFailed,
  };
}


// ------------------------------------------------------------
// 3. GET ADMIN NOTIFICATIONS
// GET /admin/notifications
// ------------------------------------------------------------

app.get(
  "/admin/notifications",
  async (req, res) => {
    try {
      const user =
        await authenticateNasaraAdminRequest(req, res);

      if (!user) return;

      const parsedLimit = Number(req.query.limit || 50);

      const limit = Math.min(
        Math.max(
          Number.isFinite(parsedLimit)
            ? Math.floor(parsedLimit)
            : 50,
          1
        ),
        100
      );

      const unreadOnly =
        req.query.unread_only === "true";

      let query = supabaseAdmin
        .from("notifications")
        .select(
          "id, user_id, sender_id, type, title, body, message, ref_id, is_read, created_at, data"
        )
        .eq("user_id", user.id)
        .order("created_at", {
          ascending: false,
        })
        .limit(limit);

      if (unreadOnly) {
        query = query.eq("is_read", false);
      }

      const {
        data: notifications,
        error: notificationsError,
      } = await query;

      if (notificationsError) {
        console.error(
          "ADMIN NOTIFICATION LOAD ERROR:",
          notificationsError
        );

        return res.status(500).json({
          success: false,
          error: "Could not load admin notifications.",
        });
      }

      const {
        count: unreadCount,
        error: countError,
      } = await supabaseAdmin
        .from("notifications")
        .select("id", {
          count: "exact",
          head: true,
        })
        .eq("user_id", user.id)
        .eq("is_read", false);

      if (countError) {
        console.error(
          "ADMIN UNREAD COUNT ERROR:",
          countError
        );

        return res.status(500).json({
          success: false,
          error: "Could not load unread notification count.",
        });
      }

      return res.json({
        success: true,
        notifications: notifications || [],
        unread_count: unreadCount || 0,
      });

    } catch (error) {
      console.error(
        "GET ADMIN NOTIFICATIONS ERROR:",
        error
      );

      return res.status(500).json({
        success: false,
        error: "Could not load admin notifications.",
      });
    }
  }
);


// ------------------------------------------------------------
// 4. GET ADMIN UNREAD COUNT
// GET /admin/notifications/unread-count
// ------------------------------------------------------------

app.get(
  "/admin/notifications/unread-count",
  async (req, res) => {
    try {
      const user =
        await authenticateNasaraAdminRequest(req, res);

      if (!user) return;

      const {
        count,
        error,
      } = await supabaseAdmin
        .from("notifications")
        .select("id", {
          count: "exact",
          head: true,
        })
        .eq("user_id", user.id)
        .eq("is_read", false);

      if (error) {
        console.error(
          "ADMIN UNREAD COUNT ERROR:",
          error
        );

        return res.status(500).json({
          success: false,
          error: "Could not load unread count.",
        });
      }

      return res.json({
        success: true,
        unread_count: count || 0,
      });

    } catch (error) {
      console.error(
        "ADMIN UNREAD COUNT ERROR:",
        error
      );

      return res.status(500).json({
        success: false,
        error: "Could not load unread count.",
      });
    }
  }
);


// ------------------------------------------------------------
// 5. MARK ONE ADMIN NOTIFICATION AS READ
// PATCH /admin/notifications/:id/read
// ------------------------------------------------------------

app.patch(
  "/admin/notifications/:id/read",
  async (req, res) => {
    try {
      const user =
        await authenticateNasaraAdminRequest(req, res);

      if (!user) return;

      const notificationId =
        String(req.params.id || "").trim();

      if (!notificationId) {
        return res.status(400).json({
          success: false,
          error: "Notification ID is required.",
        });
      }

      const {
        data: updatedNotification,
        error,
      } = await supabaseAdmin
        .from("notifications")
        .update({
          is_read: true,
        })
        .eq("id", notificationId)
        .eq("user_id", user.id)
        .select("id, is_read")
        .maybeSingle();

      if (error) {
        console.error(
          "MARK ADMIN NOTIFICATION READ ERROR:",
          error
        );

        return res.status(500).json({
          success: false,
          error: "Could not update notification.",
        });
      }

      if (!updatedNotification) {
        return res.status(404).json({
          success: false,
          error: "Notification not found.",
        });
      }

      return res.json({
        success: true,
        notification: updatedNotification,
      });

    } catch (error) {
      console.error(
        "MARK ADMIN NOTIFICATION READ ERROR:",
        error
      );

      return res.status(500).json({
        success: false,
        error: "Could not update notification.",
      });
    }
  }
);


// ------------------------------------------------------------
// 6. MARK ALL ADMIN NOTIFICATIONS AS READ
// PATCH /admin/notifications/read-all
// ------------------------------------------------------------

app.patch(
  "/admin/notifications/read-all",
  async (req, res) => {
    try {
      const user =
        await authenticateNasaraAdminRequest(req, res);

      if (!user) return;

      const {
        data: updatedNotifications,
        error,
      } = await supabaseAdmin
        .from("notifications")
        .update({
          is_read: true,
        })
        .eq("user_id", user.id)
        .eq("is_read", false)
        .select("id");

      if (error) {
        console.error(
          "MARK ALL ADMIN NOTIFICATIONS READ ERROR:",
          error
        );

        return res.status(500).json({
          success: false,
          error: "Could not mark notifications as read.",
        });
      }

      return res.json({
        success: true,
        updated_count:
          updatedNotifications?.length || 0,
      });

    } catch (error) {
      console.error(
        "MARK ALL ADMIN NOTIFICATIONS READ ERROR:",
        error
      );

      return res.status(500).json({
        success: false,
        error: "Could not mark notifications as read.",
      });
    }
  }
);


// ============================================================
// NASARA GENERAL USER SUBMISSION -> ADMIN NOTIFICATION
// POST /notifications/admin-submit
//
// Android Push + Browser Push + Supabase In-App Notifications
//
// Uses the existing createNasaraAdminNotification() function.
// ============================================================


// ------------------------------------------------------------
// 1. SUPPORTED NASARA ADMIN EVENTS
// ------------------------------------------------------------

const NASARA_ADMIN_EVENT_CONFIG = {

  // ==========================================================
  // MARKETPLACE PAYMENTS
  // ==========================================================

  ad_payment_request: {
    table: "payments",
    title: "New Advertisement Payment",
    description: "Advertisement payment submitted for verification",
    priority: "high",
    payment: true,
    products: ["ad"],
  },

  banner_payment_request: {
    table: "payments",
    title: "New Banner Payment",
    description: "Banner payment submitted for verification",
    priority: "high",
    payment: true,
    products: ["banner"],
  },

  promotion_payment_request: {
    table: "payments",
    title: "New Promotion Payment",
    description: "Promotion payment submitted for verification",
    priority: "high",
    payment: true,
    products: ["promote"],
  },

  boost_payment_request: {
    table: "payments",
    title: "New Boost Payment",
    description: "Boost payment submitted for verification",
    priority: "high",
    payment: true,
    products: ["boost"],
  },

  battle_payment_request: {
    table: "payments",
    title: "New Battle Payment",
    description: "Battle payment submitted for verification",
    priority: "high",
    payment: true,
    products: ["battle"],
  },

friday_market_payment: {
  table: "friday_market_registrations",
  ownerColumn: "seller_id",
  title: "New Friday Market Registration",
  description: "A seller has submitted a Friday Market registration and GH₵50 payment for verification",
  priority: "high",
  registration: true,
},

// ==========================================================
// DELIVERY - CUSTOMER DELIVERY PAYMENT REQUESTS
// ==========================================================

delivery_payment_request: {
  table: "deliveries",
  ownerColumn: "customer_id",
  title: "New Delivery Payment Request",
  description: "A customer has submitted a delivery request requiring payment verification",
  priority: "high",
  deliveryRequest: true,
},


  // ==========================================================
  // DELIVERY - RIDER APPLICATIONS
  // ==========================================================

  rider_application: {
    table: "rider_applications",
    title: "New Rider Application",
    description: "A new rider application needs review",
    priority: "high",
  },


  // ==========================================================
  // MENTORSHIP - MENTOR APPLICATIONS
  // ==========================================================

  mentor_application: {
    table: "mentors",
    title: "New Mentor Application",
    description: "A new user has applied to become a Nasara mentor",
    priority: "high",
  },


  // ==========================================================
  // MENTORSHIP - MENTEE REQUESTS
  // ==========================================================

  mentee_request: {
    table: "mentor_requests",
    title: "New Mentee Request",
    description: "A user has requested to be matched with a Nasara mentor",
    priority: "normal",
  },


  // ==========================================================
  // AGRICULTURE - FARM BOOST
  // ==========================================================

  farm_boost_request: {
    table: "farm_boost_requests",
    title: "New Farm Boost Request",
    description: "A farm has submitted a boost request",
    priority: "high",
  },


  // ==========================================================
  // AGRICULTURE - FEATURED FARM
  // ==========================================================

  farm_featured_request: {
    table: "farm_featured_requests",
    title: "New Featured Farm Request",
    description: "A farm has submitted a featured listing request",
    priority: "high",
  },


  // ==========================================================
  // AGRICULTURE - FARM ADVERTISEMENTS
  // ==========================================================

  farm_ad_request: {
    table: "farm_ad_requests",
    title: "New Farm Advertisement Request",
    description: "A farm has submitted an advertisement request",
    priority: "high",
  },


  // ==========================================================
  // AGRICULTURE - FARM VERIFICATION
  // ==========================================================

  farm_verification_request: {
    table: "farm_verification_requests",
    title: "New Farm Verification Request",
    description: "A farm verification request needs review",
    priority: "high",
  },


  // ==========================================================
  // AGRICULTURE - FARM SUPPLIERS
  // ==========================================================

  farm_supplier_request: {
    table: "farm_supplier_requests",
    title: "New Farm Supplier Request",
    description: "A farm supplier request needs review",
    priority: "normal",
  },

};


// ------------------------------------------------------------
// 2. GENERAL ADMIN SUBMISSION NOTIFICATION ENDPOINT
// ------------------------------------------------------------

app.post(
  "/notifications/admin-submit",
  async (req, res) => {

    try {

      // ------------------------------------------------------
      // AUTHENTICATE USER
      // ------------------------------------------------------

      const authorization =
        req.headers.authorization || "";

      if (!authorization.startsWith("Bearer ")) {
        return res.status(401).json({
          success: false,
          error: "Login required.",
        });
      }

      const accessToken =
        authorization.slice(7).trim();

      const {
        data: userData,
        error: authError,
      } = await supabaseAdmin.auth.getUser(
        accessToken
      );

      if (
        authError ||
        !userData?.user
      ) {
        return res.status(401).json({
          success: false,
          error: "Invalid or expired login session.",
        });
      }

      const user = userData.user;


      // ------------------------------------------------------
      // READ SUBMISSION DETAILS
      // ------------------------------------------------------

      const {
        type,
        ref_id,
        related_id = null,
      } = req.body || {};

      if (
        typeof type !== "string" ||
        !type.trim() ||
        (
          typeof ref_id !== "string" &&
          typeof ref_id !== "number"
        ) ||
        String(ref_id).trim() === ""
      ) {
        return res.status(400).json({
          success: false,
          error: "Notification type and reference ID are required.",
        });
      }

      const eventType =
        type.trim();

      const referenceId =
        String(ref_id).trim();

      const relatedId =
        related_id === null ||
        related_id === undefined
          ? null
          : String(related_id).trim();

      if (
        referenceId.length > 100 ||
        (
          relatedId !== null &&
          (
            !relatedId ||
            relatedId.length > 100
          )
        )
      ) {
        return res.status(400).json({
          success: false,
          error: "Invalid submission reference.",
        });
      }


      // ------------------------------------------------------
      // CHECK ALLOWED EVENT
      // ------------------------------------------------------

      const config =
        Object.prototype.hasOwnProperty.call(
          NASARA_ADMIN_EVENT_CONFIG,
          eventType
        )
          ? NASARA_ADMIN_EVENT_CONFIG[eventType]
          : null;

      if (!config) {
        return res.status(400).json({
          success: false,
          error: "Unsupported admin notification type.",
        });
      }


      // ------------------------------------------------------
      // VERIFY SUBMISSION BELONGS TO AUTHENTICATED USER
      // ------------------------------------------------------

      const ownerColumn =
  config.ownerColumn || "user_id";

const {
  data: submission,
  error: submissionError,
} = await supabaseAdmin
  .from(config.table)
  .select("*")
  .eq("id", referenceId)
  .eq(ownerColumn, user.id)
  .maybeSingle();

      if (submissionError) {
        console.error(
          "ADMIN SUBMISSION VERIFICATION ERROR:",
          submissionError
        );

        return res.status(500).json({
          success: false,
          error: "Could not verify submission.",
        });
      }

      if (!submission) {
        return res.status(404).json({
          success: false,
          error: "Submission not found or does not belong to you.",
        });
      }


      // ------------------------------------------------------
      // VERIFY PAYMENT SUBMISSIONS
      // ------------------------------------------------------

      if (config.payment) {

        if (
          String(submission.status).toLowerCase() !== "pending" ||
          !submission.product_type
        ) {
          return res.status(400).json({
            success: false,
            error: "Payment is not awaiting verification.",
          });
        }

        const actualProduct =
          String(
            submission.product_type
          ).toLowerCase().trim();

        if (
          !config.products.includes(actualProduct)
        ) {
          return res.status(400).json({
            success: false,
            error: "Payment type does not match this request.",
          });
        }
      }
      
      // ------------------------------------------------------
// VERIFY FRIDAY MARKET REGISTRATION SUBMISSIONS
// ------------------------------------------------------

if (config.registration) {

  if (
    submission.payment_status !== "pending_review" ||
    submission.registration_status !== "pending_review"
  ) {
    return res.status(400).json({
      success: false,
      error: "Friday Market registration is not awaiting verification.",
    });
  }

  if (
    Number(submission.fee_amount) !== 50 ||
    submission.currency !== "GHS" ||
    submission.payment_method !== "MTN MoMo" ||
    !submission.transaction_reference ||
    !String(submission.transaction_reference).trim()
  ) {
    return res.status(400).json({
      success: false,
      error: "Friday Market payment details are incomplete or invalid.",
    });
  }
}

// ------------------------------------------------------
// VERIFY DELIVERY PAYMENT SUBMISSIONS
// ------------------------------------------------------

if (config.deliveryRequest) {
  if (
    submission.payment_status !== "pending" ||
    submission.status !== "pending_payment" ||
    !Number.isFinite(Number(submission.amount)) ||
    Number(submission.amount) <= 0
  ) {
    return res.status(400).json({
      success: false,
      error: "Delivery request is not awaiting payment verification.",
    });
  }
}

      // ------------------------------------------------------
      // PREVENT DUPLICATE NOTIFICATIONS
      // ------------------------------------------------------

      const {
        data: existingNotification,
        error: duplicateError,
      } = await supabaseAdmin
        .from("notifications")
        .select("id")
        .eq("ref_id", referenceId)
        .eq("type", eventType)
        .limit(1)
        .maybeSingle();

      if (duplicateError) {
        console.error(
          "ADMIN NOTIFICATION DUPLICATE CHECK ERROR:",
          duplicateError
        );

        return res.status(500).json({
          success: false,
          error: "Could not check existing notification.",
        });
      }

      if (existingNotification) {
        return res.json({
          success: true,
          duplicate: true,
          message: "Administrators have already been notified.",
        });
      }


      // ------------------------------------------------------
      // PREPARE NOTIFICATION
      // ------------------------------------------------------

     const submittedAmount =
  config.registration
    ? submission.fee_amount
    : submission.amount;

const amount =
  submittedAmount !== undefined &&
  submittedAmount !== null
    ? ` GH₵${submittedAmount}`
    : "";


      // ------------------------------------------------------
      // CREATE CENTRAL ADMIN NOTIFICATION
      // ------------------------------------------------------

      const result =
        await createNasaraAdminNotification({

          type: eventType,

          title: config.title,

          body:
            `${config.description}.` +
            amount,

          ref_id: referenceId,

          sender_id: user.id,

          priority: config.priority,

          data: {

            scope: "admin",

            url: "/admin/notifications",

            event_type: eventType,

            submission_id: referenceId,

            related_id: relatedId,

            table: config.table,

            submitted_by: user.id,

          },

        });


      // ------------------------------------------------------
      // RETURN SUCCESS
      // ------------------------------------------------------

      return res.status(201).json({

        success: true,

        message: "Nasara administrators have been notified.",

        result,

      });

    } catch (error) {

      console.error(
        "NASARA ADMIN SUBMISSION NOTIFICATION ERROR:",
        error
      );

      return res.status(500).json({

        success: false,

        error:
          error.message ||
          "Could not notify Nasara administrators.",

      });

    }

  }
);


// ============================================================
// NASARA MARKETPLACE
// BUYER PAYMENT DECLARATION
//
// POST /marketplace/orders/:orderId/payment-declared
//
// Notifies:
// 1. Seller - In-app + Android + Browser
// 2. Nasara Admin - In-app + Android + Browser
//
// IMPORTANT:
// Buyer declaration is NOT payment confirmation.
// Seller must verify actual MoMo receipt.
// ============================================================

app.post(
  "/marketplace/orders/:orderId/payment-declared",
  async (req, res) => {
    try {
      // ------------------------------------------------------
      // 1. AUTHENTICATE BUYER
      // ------------------------------------------------------

      const authorization = req.headers.authorization || "";

      if (!authorization.startsWith("Bearer ")) {
        return res.status(401).json({
          success: false,
          error: "Login required.",
        });
      }

      const accessToken = authorization.slice(7).trim();

      const {
        data: userData,
        error: authError,
      } = await supabaseAdmin.auth.getUser(accessToken);

      if (authError || !userData?.user) {
        return res.status(401).json({
          success: false,
          error: "Invalid or expired login session.",
        });
      }

      const buyer = userData.user;

      // ------------------------------------------------------
      // 2. VALIDATE ORDER ID
      // ------------------------------------------------------

      const orderId = String(req.params.orderId || "").trim();

      const uuidPattern =
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

      if (!uuidPattern.test(orderId)) {
        return res.status(400).json({
          success: false,
          error: "Invalid marketplace order ID.",
        });
      }

      // ------------------------------------------------------
      // 3. READ ORDER
      // ------------------------------------------------------

      const {
        data: order,
        error: orderError,
      } = await supabaseAdmin
        .from("nasara_marketplace_orders")
        .select(`
          id,
          order_number,
          buyer_id,
          seller_id,
          total_amount,
          currency,
          payment_status,
          order_status
        `)
        .eq("id", orderId)
        .maybeSingle();

      if (orderError) {
        console.error(
          "MARKETPLACE ORDER LOOKUP ERROR:",
          orderError
        );

        return res.status(500).json({
          success: false,
          error: "Could not retrieve marketplace order.",
        });
      }

      if (!order) {
        return res.status(404).json({
          success: false,
          error: "Marketplace order not found.",
        });
      }

      // ------------------------------------------------------
      // 4. VERIFY BUYER OWNERSHIP
      // ------------------------------------------------------

      if (order.buyer_id !== buyer.id) {
        return res.status(403).json({
          success: false,
          error: "You are not authorized to submit payment for this order.",
        });
      }

      // ------------------------------------------------------
      // 5. PREVENT REPEATED DECLARATIONS
      // ------------------------------------------------------

      if (order.payment_status === "buyer_declared") {
        return res.json({
          success: true,
          duplicate: true,
          message: "You have already declared payment for this order.",
          order_id: order.id,
          payment_status: order.payment_status,
        });
      }

      if (order.payment_status !== "awaiting_payment") {
        return res.status(400).json({
          success: false,
          error: "This order is not awaiting payment declaration.",
          payment_status: order.payment_status,
        });
      }

      if (order.order_status !== "pending_payment") {
        return res.status(400).json({
          success: false,
          error: "This order is not awaiting payment.",
        });
      }

      // ------------------------------------------------------
      // 6. VALIDATE OPTIONAL PAYMENT DETAILS
      // ------------------------------------------------------

      const {
        transaction_reference = null,
        payment_note = null,
      } = req.body || {};

      const transactionReference =
        transaction_reference === null
          ? null
          : String(transaction_reference).trim();

      const paymentNote =
        payment_note === null
          ? null
          : String(payment_note).trim();

      if (
        transactionReference &&
        transactionReference.length > 150
      ) {
        return res.status(400).json({
          success: false,
          error: "Transaction reference is too long.",
        });
      }

      if (
        paymentNote &&
        paymentNote.length > 1000
      ) {
        return res.status(400).json({
          success: false,
          error: "Payment note is too long.",
        });
      }

      // ------------------------------------------------------
      // 7. UPDATE ORDER ATOMICALLY
      //
      // Only the first valid declaration can update the order.
      // ------------------------------------------------------

      const declaredAt = new Date().toISOString();

      const {
        data: updatedOrder,
        error: updateError,
      } = await supabaseAdmin
        .from("nasara_marketplace_orders")
        .update({
          payment_status: "buyer_declared",
          buyer_declared_at: declaredAt,
          buyer_transaction_reference: transactionReference,
          buyer_payment_note: paymentNote,
        })
        .eq("id", orderId)
        .eq("buyer_id", buyer.id)
        .eq("payment_status", "awaiting_payment")
        .eq("order_status", "pending_payment")
        .select("id,order_number,buyer_id,seller_id,total_amount,currency,payment_status")
        .maybeSingle();

      if (updateError) {
        console.error(
          "MARKETPLACE PAYMENT DECLARATION UPDATE ERROR:",
          updateError
        );

        return res.status(500).json({
          success: false,
          error: "Could not submit payment declaration.",
        });
      }

      if (!updatedOrder) {
        return res.status(409).json({
          success: false,
          error: "This order has already been updated. Refresh and check its payment status.",
        });
      }

      // ------------------------------------------------------
      // 8. PREPARE NOTIFICATION DETAILS
      // ------------------------------------------------------

      const orderLabel =
        `Order #${updatedOrder.order_number}`;

      const amount =
        `${updatedOrder.currency} ${Number(
          updatedOrder.total_amount
        ).toFixed(2)}`;

      const notificationTitle =
        "Buyer Has Declared Payment";

      const notificationBody =
        `A buyer has declared payment for ${orderLabel}. Amount: ${amount}. Please verify your MoMo account.`;

      const notificationData = {
        type: "marketplace_payment_declared",
        scope: "marketplace",
        order_id: updatedOrder.id,
        order_number: updatedOrder.order_number,
        buyer_id: buyer.id,
        seller_id: updatedOrder.seller_id,
        payment_status: "buyer_declared",
        url: "/seller/orders",
      };

      // ------------------------------------------------------
      // 9. CREATE SELLER IN-APP NOTIFICATION
      // ------------------------------------------------------

      const sellerNotificationResult =
        await supabaseAdmin
          .from("notifications")
          .insert({
            user_id: updatedOrder.seller_id,
            sender_id: buyer.id,
            type: "marketplace_payment_declared",
            title: notificationTitle,
            body: notificationBody,
            message: notificationBody,
            ref_id: updatedOrder.id,
            is_read: false,
            data: notificationData,
          })
          .select("id")
          .maybeSingle();

      if (sellerNotificationResult.error) {
        console.error(
          "SELLER MARKETPLACE IN-APP NOTIFICATION ERROR:",
          sellerNotificationResult.error
        );
      }

      // ------------------------------------------------------
      // 10. SEND SELLER AND ADMIN NOTIFICATIONS
      // ------------------------------------------------------

      const notificationTasks = [];

      // Seller Android push
      notificationTasks.push(
        notifyUser(
          updatedOrder.seller_id,
          notificationTitle,
          notificationBody,
          notificationData
        )
      );

      // Seller browser push
      notificationTasks.push(
        sendBrowserPushToUser(
          updatedOrder.seller_id,
          notificationTitle,
          notificationBody,
          "/seller/orders",
          {
            tag: `nasara-marketplace-order-${updatedOrder.id}`,
            type: "marketplace_payment_declared",
            extraData: notificationData,
          }
        )
      );

      // ------------------------------------------------------
      // 11. NOTIFY NASARA ADMIN
      //
      // Existing helper sends:
      // In-app + Android + Browser notifications.
      // ------------------------------------------------------

      const adminNotificationTask =
        createNasaraAdminNotification({
          type: "marketplace_payment_declared",
          title: "New Marketplace Payment Declaration",
          body:
            `A buyer has declared payment for ${orderLabel}. ` +
            `Amount: ${amount}. Seller confirmation is required.`,
          ref_id: updatedOrder.id,
          sender_id: buyer.id,
          priority: "high",
          data: {
            scope: "admin",
            event_type: "marketplace_payment_declared",
            url: "/admin/notifications",
            order_id: updatedOrder.id,
            order_number: updatedOrder.order_number,
            buyer_id: buyer.id,
            seller_id: updatedOrder.seller_id,
            payment_status: "buyer_declared",
            table: "nasara_marketplace_orders",
          },
        });

      notificationTasks.push(adminNotificationTask);

      // ------------------------------------------------------
      // 12. WAIT FOR NOTIFICATION ATTEMPTS
      //
      // Notification failure does not undo a valid declaration.
      // ------------------------------------------------------

      const notificationResults =
        await Promise.allSettled(notificationTasks);

      notificationResults.forEach((result, index) => {
        if (result.status === "rejected") {
          console.error(
            "MARKETPLACE NOTIFICATION TASK FAILED:",
            index,
            result.reason
          );
        }
      });

      const sellerInAppSaved =
        !sellerNotificationResult.error;

      const sellerAndroid =
        notificationResults[0];

      const sellerBrowser =
        notificationResults[1];

      const adminNotification =
        notificationResults[2];

      // ------------------------------------------------------
      // 13. RETURN SUCCESS
      // ------------------------------------------------------

      return res.status(200).json({
        success: true,

        message:
          "Payment declaration submitted. The seller and Nasara administrators have been notified.",

        order: {
          id: updatedOrder.id,
          order_number: updatedOrder.order_number,
          payment_status: updatedOrder.payment_status,
        },

        notifications: {
          seller: {
            in_app: sellerInAppSaved,
            android:
              sellerAndroid.status === "fulfilled",
            browser:
              sellerBrowser.status === "fulfilled",
          },

          admin:
            adminNotification.status === "fulfilled",
        },
      });

    } catch (error) {
      console.error(
        "NASARA MARKETPLACE PAYMENT DECLARATION ERROR:",
        error
      );

      return res.status(500).json({
        success: false,
        error:
          error.message ||
          "Could not submit marketplace payment declaration.",
      });
    }
  }
);

// ============================================================
// NASARA MARKETPLACE
// SELLER PAYMENT CONFIRMATION / REJECTION
//
// POST /marketplace/orders/:orderId/payment-decision
//
// Body:
// { "decision": "confirmed" }
// OR
// { "decision": "rejected", "rejection_reason": "..." }
//
// Confirmation automatically creates the 5% commission.
// Buyer and Nasara Admin are notified.
// ============================================================

app.post(
  "/marketplace/orders/:orderId/payment-decision",
  async (req, res) => {
    try {
      // ------------------------------------------------------
      // 1. AUTHENTICATE SELLER
      // ------------------------------------------------------

      const authorization = req.headers.authorization || "";

      if (!authorization.startsWith("Bearer ")) {
        return res.status(401).json({
          success: false,
          error: "Login required.",
        });
      }

      const accessToken = authorization.slice(7).trim();

      const {
        data: userData,
        error: authError,
      } = await supabaseAdmin.auth.getUser(accessToken);

      if (authError || !userData?.user) {
        return res.status(401).json({
          success: false,
          error: "Invalid or expired login session.",
        });
      }

      const seller = userData.user;

      // ------------------------------------------------------
      // 2. VALIDATE ORDER ID
      // ------------------------------------------------------

      const orderId = String(req.params.orderId || "").trim();

      const uuidPattern =
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

      if (!uuidPattern.test(orderId)) {
        return res.status(400).json({
          success: false,
          error: "Invalid marketplace order ID.",
        });
      }

      // ------------------------------------------------------
      // 3. VALIDATE DECISION
      // ------------------------------------------------------

      const {
        decision,
        rejection_reason = null,
      } = req.body || {};

      if (!["confirmed", "rejected"].includes(decision)) {
        return res.status(400).json({
          success: false,
          error: "Decision must be confirmed or rejected.",
        });
      }

      const rejectionReason =
        rejection_reason === null
          ? null
          : String(rejection_reason).trim();

      if (decision === "rejected") {
        if (
          !rejectionReason ||
          rejectionReason.length > 500
        ) {
          return res.status(400).json({
            success: false,
            error: "Please provide a rejection reason of no more than 500 characters.",
          });
        }
      }

      // ------------------------------------------------------
      // 4. VERIFY SELLER OWNS THE ORDER
      // ------------------------------------------------------

      const {
        data: existingOrder,
        error: orderError,
      } = await supabaseAdmin
        .from("nasara_marketplace_orders")
        .select("id,seller_id,buyer_id,payment_status")
        .eq("id", orderId)
        .maybeSingle();

      if (orderError) {
        console.error(
          "MARKETPLACE SELLER ORDER LOOKUP ERROR:",
          orderError
        );

        return res.status(500).json({
          success: false,
          error: "Could not retrieve order.",
        });
      }

      if (!existingOrder) {
        return res.status(404).json({
          success: false,
          error: "Marketplace order not found.",
        });
      }

      if (existingOrder.seller_id !== seller.id) {
        return res.status(403).json({
          success: false,
          error: "You are not authorized to manage this order.",
        });
      }

      if (existingOrder.payment_status !== "buyer_declared") {
        return res.status(409).json({
          success: false,
          error: "This payment is not awaiting seller confirmation.",
        });
      }

      // ------------------------------------------------------
      // 5. ATOMIC DATABASE DECISION
      //
      // The SQL function locks the order, changes its status
      // and creates the commission in one transaction.
      // ------------------------------------------------------

      const {
        data: decisionResult,
        error: decisionError,
      } = await supabaseAdmin.rpc(
        "nasara_marketplace_seller_payment_decision",
        {
          p_order_id: orderId,
          p_seller_id: seller.id,
          p_decision: decision,
          p_rejection_reason: rejectionReason,
        }
      );

      if (decisionError) {
        console.error(
          "MARKETPLACE SELLER PAYMENT DECISION ERROR:",
          decisionError
        );

        const errorMessage = decisionError.message || "";

        if (
          errorMessage.includes("NOT_ORDER_SELLER")
        ) {
          return res.status(403).json({
            success: false,
            error: "You are not authorized to manage this order.",
          });
        }

        if (
          errorMessage.includes("ORDER_NOT_FOUND") ||
          errorMessage.includes("PAYMENT_NOT_AWAITING_SELLER_DECISION")
        ) {
          return res.status(409).json({
            success: false,
            error: "The order has changed or is no longer awaiting your decision.",
          });
        }

        if (
          errorMessage.includes("REJECTION_REASON_REQUIRED") ||
          errorMessage.includes("INVALID_DECISION")
        ) {
          return res.status(400).json({
            success: false,
            error: "Invalid payment decision.",
          });
        }

        return res.status(500).json({
          success: false,
          error: "Could not process seller payment decision.",
        });
      }

      // ------------------------------------------------------
      // 6. PREPARE NOTIFICATIONS
      // ------------------------------------------------------

      const result = decisionResult;

      const orderLabel = `Order #${result.order_number}`;

      const isConfirmed = decision === "confirmed";

      const title = isConfirmed
        ? "Payment Confirmed"
        : "Payment Declaration Rejected";

      const body = isConfirmed
        ? `The seller has confirmed receipt of your payment for ${orderLabel}. Your order is now being processed.`
        : `The seller could not verify your payment for ${orderLabel}. Reason: ${rejectionReason}`;

      const notificationData = {
        type: isConfirmed
          ? "marketplace_payment_confirmed"
          : "marketplace_payment_rejected",

        scope: "marketplace",
        order_id: result.order_id,
        order_number: result.order_number,
        buyer_id: result.buyer_id,
        seller_id: result.seller_id,
        payment_status: result.payment_status,
        order_status: result.order_status,
        url: "/",
      };

      // ------------------------------------------------------
      // 7. CREATE BUYER IN-APP NOTIFICATION
      // ------------------------------------------------------

      const buyerInAppTask = supabaseAdmin
        .from("notifications")
        .insert({
          user_id: result.buyer_id,
          sender_id: seller.id,
          type: notificationData.type,
          title,
          body,
          message: body,
          ref_id: result.order_id,
          is_read: false,
          data: notificationData,
        });

      // ------------------------------------------------------
      // 8. SEND BUYER ANDROID + BROWSER PUSH
      // ------------------------------------------------------

      const buyerAndroidTask = notifyUser(
        result.buyer_id,
        title,
        body,
        notificationData
      );

      const buyerBrowserTask = sendBrowserPushToUser(
        result.buyer_id,
        title,
        body,
        "/",
        {
          tag: `nasara-marketplace-decision-${result.order_id}`,
          type: notificationData.type,
          extraData: notificationData,
        }
      );

      // ------------------------------------------------------
      // 9. NOTIFY NASARA ADMIN
      // ------------------------------------------------------

      const adminTitle = isConfirmed
        ? "Marketplace Payment Confirmed by Seller"
        : "Marketplace Payment Rejected by Seller";

      const adminBody = isConfirmed
        ? `${orderLabel} payment has been confirmed by the seller. A 5% commission has been recorded.`
        : `${orderLabel} payment declaration was rejected by the seller. Reason: ${rejectionReason}`;

      const adminTask = createNasaraAdminNotification({
        type: notificationData.type,
        title: adminTitle,
        body: adminBody,
        ref_id: result.order_id,
        sender_id: seller.id,
        priority: "high",
        data: {
          scope: "admin",
          url: "/admin/notifications",
          event_type: notificationData.type,
          order_id: result.order_id,
          order_number: result.order_number,
          buyer_id: result.buyer_id,
          seller_id: result.seller_id,
          payment_status: result.payment_status,
          commission_amount: result.commission_amount,
          currency: result.currency,
          table: "nasara_marketplace_orders",
        },
      });

      // ------------------------------------------------------
      // 10. WAIT FOR NOTIFICATION ATTEMPTS
      // ------------------------------------------------------

      const notificationResults = await Promise.allSettled([
        buyerInAppTask,
        buyerAndroidTask,
        buyerBrowserTask,
        adminTask,
      ]);

      notificationResults.forEach((task, index) => {
        if (task.status === "rejected") {
          console.error(
            "MARKETPLACE DECISION NOTIFICATION FAILED:",
            index,
            task.reason
          );
        }
      });

      if (
        notificationResults[0].status === "fulfilled" &&
        notificationResults[0].value?.error
      ) {
        console.error(
          "BUYER IN-APP NOTIFICATION INSERT ERROR:",
          notificationResults[0].value.error
        );
      }

      // ------------------------------------------------------
      // 11. RETURN RESULT
      // ------------------------------------------------------

      return res.status(200).json({
        success: true,

        message: isConfirmed
          ? "Payment confirmed. The order is processing and the 5% commission has been recorded."
          : "Payment declaration rejected. The buyer has been notified.",

        order: {
          id: result.order_id,
          order_number: result.order_number,
          payment_status: result.payment_status,
          order_status: result.order_status,
        },

        commission: isConfirmed
          ? {
              amount: result.commission_amount,
              currency: result.currency,
              payment_status: "pending",
            }
          : null,

        notifications: {
          buyer_in_app:
            notificationResults[0].status === "fulfilled" &&
            !notificationResults[0].value?.error,

          buyer_android:
            notificationResults[1].status === "fulfilled",

          buyer_browser:
            notificationResults[2].status === "fulfilled",

          admin:
            notificationResults[3].status === "fulfilled",
        },
      });

    } catch (error) {
      console.error(
        "NASARA MARKETPLACE SELLER DECISION ERROR:",
        error
      );

      return res.status(500).json({
        success: false,
        error:
          error.message ||
          "Could not process payment decision.",
      });
    }
  }
);
// ============================================================
// NASARA MARKETPLACE: CREATE ORDERS
// POST /marketplace/orders/create
//
// Creates one order per seller.
// Retrieves product prices and seller details from Supabase.
// Saves order items and notifies sellers + Nasara Admin.
// ============================================================

app.post("/marketplace/orders/create", async (req, res) => {
  const createdOrderIds = [];

  try {
    // --------------------------------------------------------
    // 1. AUTHENTICATE BUYER
    // --------------------------------------------------------

    const authHeader = req.headers.authorization || "";
    const token = authHeader.startsWith("Bearer ")
      ? authHeader.slice(7)
      : null;

    if (!token) {
      return res.status(401).json({
        success: false,
        error: "Authentication required.",
      });
    }

    const {
      data: authData,
      error: authError,
    } = await supabaseAdmin.auth.getUser(token);

    if (authError || !authData?.user) {
      return res.status(401).json({
        success: false,
        error: "Invalid or expired session.",
      });
    }

    const buyerId = authData.user.id;

    // --------------------------------------------------------
    // 2. VALIDATE REQUEST
    // --------------------------------------------------------

    const {
      items,
      delivery_address,
      delivery_location,
      buyer_phone,
    } = req.body || {};

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({
        success: false,
        error: "Your cart is empty.",
      });
    }

    if (items.length > 100) {
      return res.status(400).json({
        success: false,
        error: "Too many products in one checkout.",
      });
    }

    // Combine duplicate product IDs.
    const quantities = new Map();

    for (const item of items) {
      const productId = String(item.product_id || "").trim();
      const quantity = Number(item.quantity);

      if (!productId) {
        return res.status(400).json({
          success: false,
          error: "A cart item is missing its product ID.",
        });
      }

      if (
        !Number.isInteger(quantity) ||
        quantity < 1 ||
        quantity > 99
      ) {
        return res.status(400).json({
          success: false,
          error: "Invalid product quantity.",
        });
      }

      const newQuantity =
        (quantities.get(productId) || 0) + quantity;

      if (newQuantity > 99) {
        return res.status(400).json({
          success: false,
          error: "Maximum quantity per product is 99.",
        });
      }

      quantities.set(productId, newQuantity);
    }

    const productIds = Array.from(quantities.keys());

   // --------------------------------------------------------
    // 3. FETCH AUTHORITATIVE PRODUCT INFORMATION
    // Actual items_live ownership column is user_id.
    // --------------------------------------------------------

    const {
      data: products,
      error: productsError,
    } = await supabaseAdmin
      .from("items_live")
      .select("id,title,price,user_id,image_urls")
      .in("id", productIds);

    if (productsError) {
      console.error("NASARA MARKETPLACE PRODUCT LOOKUP FAILED:", {
        message: productsError.message,
        code: productsError.code,
        details: productsError.details,
        hint: productsError.hint,
      });

      return res.status(500).json({
        success: false,
        error: "Unable to verify the products in your cart.",
        details: productsError.message,
        code: productsError.code,
      });
    }

    if (!products || products.length !== productIds.length) {
      return res.status(400).json({
        success: false,
        error: "One or more products are no longer available.",
      });
    }

    
    
    // --------------------------------------------------------
    // 4. GROUP PRODUCTS BY SELLER
    // Actual items_live seller ownership column is user_id.
    // --------------------------------------------------------

    const sellerGroups = new Map();

    for (const product of products) {
      const sellerId = product.user_id;

      if (!sellerId) {
        return res.status(400).json({
          success: false,
          error: `Product "${product.title}" has no valid seller.`,
        });
      }

      const price = Number(product.price);

      if (!Number.isFinite(price) || price < 0) {
        return res.status(400).json({
          success: false,
          error: `Product "${product.title}" has an invalid price.`,
        });
      }

      const quantity = quantities.get(String(product.id));
      const lineTotal = Math.round(price * quantity * 100) / 100;

      if (!sellerGroups.has(sellerId)) {
        sellerGroups.set(sellerId, {
          seller_id: sellerId,
          items: [],
          subtotal: 0,
        });
      }

      const group = sellerGroups.get(sellerId);

      group.items.push({
        product_id: String(product.id),
        product_title: product.title || "Nasara product",
        product_image: Array.isArray(product.image_urls)
          ? product.image_urls[0] || null
          : null,
        quantity,
        unit_price: price,
        line_total: lineTotal,
      });

      group.subtotal =
        Math.round((group.subtotal + lineTotal) * 100) / 100;
    }

    const sellerIds = Array.from(sellerGroups.keys());
    // --------------------------------------------------------
    // 5. FETCH SELLER PROFILES AND MOMO DETAILS
    // --------------------------------------------------------

    const {
      data: sellers,
      error: sellersError,
    } = await supabaseAdmin
      .from("profiles")
      .select(
        "id,momo_name,momo_number,business_name,full_name,username"
      )
      .in("id", sellerIds);

    if (sellersError) {
      console.error("Marketplace seller lookup:", sellersError);

      return res.status(500).json({
        success: false,
        error: "Unable to retrieve seller payment details.",
      });
    }

    const sellerMap = new Map(
      (sellers || []).map((seller) => [seller.id, seller])
    );

    for (const sellerId of sellerIds) {
      const seller = sellerMap.get(sellerId);

      if (!seller) {
        return res.status(400).json({
          success: false,
          error: "A seller profile could not be found.",
        });
      }

      if (!seller.momo_number) {
        return res.status(400).json({
          success: false,
          error:
            "A seller has not added a MoMo number. Please contact the seller before checkout.",
        });
      }
    }

    // --------------------------------------------------------
    // 6. CREATE ONE ORDER PER SELLER
    // --------------------------------------------------------

    const createdOrders = [];

    for (const sellerId of sellerIds) {
      const group = sellerGroups.get(sellerId);
      const seller = sellerMap.get(sellerId);

      const sellerName =
        seller.momo_name ||
        seller.business_name ||
        seller.full_name ||
        seller.username ||
        "Nasara Seller";

      const { data: order, error: orderError } =
        await supabaseAdmin
          .from("nasara_marketplace_orders")
          .insert({
            buyer_id: buyerId,
            seller_id: sellerId,
            currency: "GHS",
            subtotal: group.subtotal,
            total_amount: group.subtotal,

            seller_momo_name: sellerName,
            seller_momo_number: seller.momo_number,

            payment_status: "awaiting_payment",
            order_status: "pending_payment",

            delivery_address: delivery_address || null,
            delivery_location: delivery_location || null,
            buyer_phone: buyer_phone || null,
          })
          .select("*")
          .single();

      if (orderError || !order) {
        console.error("Marketplace order creation:", orderError);
        throw new Error("ORDER_CREATION_FAILED");
      }

      createdOrderIds.push(order.id);

      const orderItems = group.items.map((item) => ({
        ...item,
        order_id: order.id,
      }));

      const {
        error: itemsError,
      } = await supabaseAdmin
        .from("nasara_marketplace_order_items")
        .insert(orderItems);

      if (itemsError) {
        console.error("Marketplace order items:", itemsError);
        throw new Error("ORDER_ITEMS_CREATION_FAILED");
      }

      createdOrders.push({
        ...order,
        seller_name: sellerName,
        item_count: group.items.length,
        items: group.items,
      });
    }

    // --------------------------------------------------------
    // 7. NOTIFY EACH SELLER
    // --------------------------------------------------------

    const notificationTasks = [];

    for (const order of createdOrders) {
      const sellerMessage =
        `You have received a new Nasara order #${order.order_number}. ` +
        `Order amount: GH₵${Number(order.total_amount).toFixed(2)}.`;

      notificationTasks.push(
        (async () => {
          const { error } = await supabaseAdmin
            .from("notifications")
            .insert({
              user_id: order.seller_id,
              sender_id: buyerId,
              type: "marketplace_new_order",
              title: "New Marketplace Order",
              body: sellerMessage,
              message: sellerMessage,
              ref_id: String(order.id),
              is_read: false,
              data: {
                scope: "seller",
                type: "marketplace_new_order",
                order_id: order.id,
                order_number: order.order_number,
                url: "/seller/orders",
              },
            });

          if (error) {
            throw error;
          }
        })()
      );

      notificationTasks.push(
        notifyUser(
          order.seller_id,
          "New Marketplace Order",
          sellerMessage,
          {
            type: "marketplace_new_order",
            order_id: order.id,
            order_number: order.order_number,
            url: "/seller/orders",
          }
        )
      );

      notificationTasks.push(
        sendBrowserPushToUser(
          order.seller_id,
          "New Marketplace Order",
          sellerMessage,
          "/seller/orders",
          {
            tag: `marketplace-order-${order.id}`,
            type: "marketplace_new_order",
            extraData: {
              order_id: order.id,
              order_number: order.order_number,
            },
          }
        )
      );

      notificationTasks.push(
        createNasaraAdminNotification({
          type: "marketplace_new_order",
          title: "New Marketplace Order",
          body:
            `A buyer placed order #${order.order_number}. ` +
            `Seller: ${order.seller_name}. ` +
            `Amount: GH₵${Number(order.total_amount).toFixed(2)}.`,
          ref_id: order.id,
          sender_id: buyerId,
          priority: "normal",
          data: {
            order_id: order.id,
            order_number: order.order_number,
            seller_id: order.seller_id,
            buyer_id: buyerId,
            url: "/admin/notifications",
          },
        })
      );
    }

    const notificationResults =
      await Promise.allSettled(notificationTasks);

    // --------------------------------------------------------
    // 8. RETURN CREATED ORDERS
    // --------------------------------------------------------

    return res.status(201).json({
      success: true,
      message: "Your marketplace orders have been created.",
      orders: createdOrders.map((order) => ({
  id: order.id,
  order_number: order.order_number,

  buyer_id: order.buyer_id,
  seller_id: order.seller_id,

  seller_name: order.seller_name,

  // Seller's payment details saved on this order
  seller_momo_name: order.seller_momo_name,
  seller_momo_number: order.seller_momo_number,

  subtotal: order.subtotal,
  total_amount: order.total_amount,
  currency: order.currency,

  payment_status: order.payment_status,
  order_status: order.order_status,

  item_count: order.item_count,
})),
      total_orders: createdOrders.length,
      notifications_attempted: notificationResults.length,
    });

  } catch (error) {
    console.error("NASARA MARKETPLACE ORDER ERROR:", error);

    // Compensating cleanup: remove any orders created by this
    // request if a later order or item insert failed.
    if (createdOrderIds.length > 0) {
      const { error: cleanupError } = await supabaseAdmin
        .from("nasara_marketplace_orders")
        .delete()
        .in("id", createdOrderIds);

      if (cleanupError) {
        console.error(
          "Marketplace order cleanup failed:",
          cleanupError
        );
      }
    }

    return res.status(500).json({
      success: false,
      error:
        error.message === "ORDER_CREATION_FAILED" ||
        error.message === "ORDER_ITEMS_CREATION_FAILED"
          ? "We could not complete your checkout. Please try again."
          : "An unexpected error occurred while creating your orders.",
    });
  }
});

// ============================================================
// NASARA MARKETPLACE: SELLER COMMISSION PAYMENT SUBMISSION
// POST /marketplace/commissions/:commissionId/payment-submit
//
// Seller submits MoMo transaction reference after paying
// Nasara's 5% marketplace commission.
//
// Admin receives:
// - In-app notification
// - Android push notification
// - Browser push notification
// ============================================================

app.post(
  "/marketplace/commissions/:commissionId/payment-submit",
  async (req, res) => {
    try {
      // ------------------------------------------------------
      // 1. AUTHENTICATE SELLER
      // ------------------------------------------------------

      const authHeader = req.headers.authorization || "";
      const token = authHeader.startsWith("Bearer ")
        ? authHeader.slice(7)
        : null;

      if (!token) {
        return res.status(401).json({
          success: false,
          error: "Authentication required.",
        });
      }

      const {
        data: authData,
        error: authError,
      } = await supabaseAdmin.auth.getUser(token);

      if (authError || !authData?.user) {
        return res.status(401).json({
          success: false,
          error: "Invalid or expired session.",
        });
      }

      const sellerId = authData.user.id;
      const commissionId = req.params.commissionId;

      // ------------------------------------------------------
      // 2. VALIDATE COMMISSION ID
      // ------------------------------------------------------

      const uuidRegex =
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

      if (!uuidRegex.test(commissionId)) {
        return res.status(400).json({
          success: false,
          error: "Invalid commission ID.",
        });
      }

      // ------------------------------------------------------
      // 3. VALIDATE PAYMENT REFERENCE
      // ------------------------------------------------------

      const transactionReference = String(
        req.body?.transaction_reference || ""
      ).trim();

      if (
        transactionReference.length < 4 ||
        transactionReference.length > 120
      ) {
        return res.status(400).json({
          success: false,
          error: "Enter a valid MoMo transaction reference.",
        });
      }

      // ------------------------------------------------------
      // 4. FETCH COMMISSION
      // ------------------------------------------------------

      const {
        data: commission,
        error: commissionError,
      } = await supabaseAdmin
        .from("nasara_marketplace_commissions")
        .select(`
          id,
          order_id,
          seller_id,
          currency,
          commission_rate,
          order_subtotal,
          commission_amount,
          payment_status
        `)
        .eq("id", commissionId)
        .maybeSingle();

      if (commissionError) {
        console.error(
          "Commission lookup error:",
          commissionError
        );

        return res.status(500).json({
          success: false,
          error: "Unable to retrieve commission details.",
        });
      }

      if (!commission) {
        return res.status(404).json({
          success: false,
          error: "Commission record not found.",
        });
      }

      // ------------------------------------------------------
      // 5. VERIFY SELLER OWNERSHIP
      // ------------------------------------------------------

      if (commission.seller_id !== sellerId) {
        return res.status(403).json({
          success: false,
          error: "You are not authorized to submit this payment.",
        });
      }

      // ------------------------------------------------------
      // 6. CHECK COMMISSION PAYMENT STATUS
      //
      // Allow a seller to resubmit after an admin rejection.
      // ------------------------------------------------------

      if (
        !["pending", "rejected"].includes(
          commission.payment_status
        )
      ) {
        return res.status(409).json({
          success: false,
          error:
            "This commission cannot be submitted in its current status.",
          payment_status: commission.payment_status,
        });
      }

      // ------------------------------------------------------
      // 7. UPDATE COMMISSION
      //
      // Conditional update prevents duplicate submissions
      // from overwriting an already submitted payment.
      // ------------------------------------------------------

      const {
        data: updatedCommission,
        error: updateError,
      } = await supabaseAdmin
        .from("nasara_marketplace_commissions")
        .update({
          payment_status: "seller_submitted",
          seller_payment_reference: transactionReference,
          seller_submitted_at: new Date().toISOString(),

          // Reset previous admin decision when resubmitting.
          admin_verified_by: null,
          admin_verified_at: null,
          admin_notes: null,
        })
        .eq("id", commissionId)
        .eq("seller_id", sellerId)
        .in("payment_status", ["pending", "rejected"])
        .select("*")
        .maybeSingle();

      if (updateError) {
        console.error(
          "Commission submission update error:",
          updateError
        );

        return res.status(500).json({
          success: false,
          error: "Unable to submit your commission payment.",
        });
      }

      if (!updatedCommission) {
        return res.status(409).json({
          success: false,
          error:
            "This commission has already been submitted or its status has changed. Refresh and try again.",
        });
      }

      // ------------------------------------------------------
      // 8. GET SELLER NAME
      // ------------------------------------------------------

      const {
        data: sellerProfile,
      } = await supabaseAdmin
        .from("profiles")
        .select("full_name,business_name,username")
        .eq("id", sellerId)
        .maybeSingle();

      const sellerName =
        sellerProfile?.business_name ||
        sellerProfile?.full_name ||
        sellerProfile?.username ||
        "Nasara Seller";

      const commissionAmount = Number(
        updatedCommission.commission_amount
      ).toFixed(2);

      const currency = updatedCommission.currency || "GHS";

      // ------------------------------------------------------
      // 9. NOTIFY NASARA ADMIN
      //
      // Existing helper sends:
      // - In-app notifications
      // - Android push
      // - Browser push
      // ------------------------------------------------------

      const adminNotification =
        createNasaraAdminNotification({
          type: "marketplace_commission_submitted",
          title: "Marketplace Commission Payment Submitted",
          body:
            `${sellerName} submitted a commission payment ` +
            `of ${currency} ${commissionAmount} for order ` +
            `#${updatedCommission.order_id}. ` +
            `Transaction reference: ${transactionReference}. ` +
            `Admin verification is required.`,
          ref_id: updatedCommission.id,
          sender_id: sellerId,
          priority: "high",
          data: {
            commission_id: updatedCommission.id,
            order_id: updatedCommission.order_id,
            seller_id: sellerId,
            seller_name: sellerName,
            commission_amount: updatedCommission.commission_amount,
            currency,
            transaction_reference: transactionReference,
            payment_status: "seller_submitted",
            url: "/admin/notifications",
          },
        });

      const notificationResult =
        await Promise.allSettled([adminNotification]);

      // ------------------------------------------------------
      // 10. RESPONSE
      // ------------------------------------------------------

      return res.status(200).json({
        success: true,
        message:
          "Your commission payment reference has been submitted. Nasara Admin will verify your payment.",
        commission: {
          id: updatedCommission.id,
          order_id: updatedCommission.order_id,
          amount: updatedCommission.commission_amount,
          currency,
          payment_status: updatedCommission.payment_status,
          seller_payment_reference:
            updatedCommission.seller_payment_reference,
          seller_submitted_at:
            updatedCommission.seller_submitted_at,
        },
        admin_notification:
          notificationResult[0].status === "fulfilled"
            ? "notification_helper_completed"
            : "notification_helper_failed",
      });

    } catch (error) {
      console.error(
        "NASARA COMMISSION SUBMISSION ERROR:",
        error
      );

      return res.status(500).json({
        success: false,
        error:
          "An unexpected error occurred while submitting your commission payment.",
      });
    }
  }
);

// ============================================================
// NASARA MARKETPLACE: ADMIN COMMISSION VERIFICATION
// POST /marketplace/commissions/:commissionId/admin-decision
//
// Admin approves or rejects seller commission payment.
// Seller receives all three notification types.
// ============================================================

app.post(
  "/marketplace/commissions/:commissionId/admin-decision",
  async (req, res) => {
    try {
      // ------------------------------------------------------
      // 1. AUTHENTICATE ADMIN
      // ------------------------------------------------------

      const authHeader = req.headers.authorization || "";
      const token = authHeader.startsWith("Bearer ")
        ? authHeader.slice(7)
        : null;

      if (!token) {
        return res.status(401).json({
          success: false,
          error: "Authentication required.",
        });
      }

      const {
        data: authData,
        error: authError,
      } = await supabaseAdmin.auth.getUser(token);

      if (authError || !authData?.user) {
        return res.status(401).json({
          success: false,
          error: "Invalid or expired session.",
        });
      }

      const adminId = authData.user.id;

      // ------------------------------------------------------
      // 2. VERIFY ADMIN MEMBERSHIP
      // ------------------------------------------------------

      const {
        data: adminRecord,
        error: adminError,
      } = await supabaseAdmin
        .from("admins")
        .select("user_id")
        .eq("user_id", adminId)
        .maybeSingle();

      if (adminError) {
        console.error("Admin verification error:", adminError);

        return res.status(500).json({
          success: false,
          error: "Unable to verify admin permissions.",
        });
      }

      if (!adminRecord) {
        return res.status(403).json({
          success: false,
          error: "Admin access required.",
        });
      }

      // ------------------------------------------------------
      // 3. VALIDATE COMMISSION ID
      // ------------------------------------------------------

      const commissionId = req.params.commissionId;

      const uuidRegex =
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

      if (!uuidRegex.test(commissionId)) {
        return res.status(400).json({
          success: false,
          error: "Invalid commission ID.",
        });
      }

      // ------------------------------------------------------
      // 4. VALIDATE ADMIN DECISION
      // ------------------------------------------------------

      const decision = String(
        req.body?.decision || ""
      ).trim().toLowerCase();

      const adminNotes = String(
        req.body?.admin_notes || ""
      ).trim();

      if (!["approved", "rejected"].includes(decision)) {
        return res.status(400).json({
          success: false,
          error: "Decision must be approved or rejected.",
        });
      }

      if (decision === "rejected" && !adminNotes) {
        return res.status(400).json({
          success: false,
          error: "Please provide a reason for rejecting the payment.",
        });
      }

      if (adminNotes.length > 500) {
        return res.status(400).json({
          success: false,
          error: "Admin notes cannot exceed 500 characters.",
        });
      }

      // ------------------------------------------------------
      // 5. FETCH COMMISSION
      // ------------------------------------------------------

      const {
        data: commission,
        error: commissionError,
      } = await supabaseAdmin
        .from("nasara_marketplace_commissions")
        .select("*")
        .eq("id", commissionId)
        .maybeSingle();

      if (commissionError) {
        console.error(
          "Commission lookup error:",
          commissionError
        );

        return res.status(500).json({
          success: false,
          error: "Unable to retrieve commission record.",
        });
      }

      if (!commission) {
        return res.status(404).json({
          success: false,
          error: "Commission record not found.",
        });
      }

      // ------------------------------------------------------
      // 6. ONLY VERIFY SUBMITTED PAYMENTS
      // ------------------------------------------------------

      if (commission.payment_status !== "seller_submitted") {
        return res.status(409).json({
          success: false,
          error:
            "Only submitted commission payments can be verified.",
          current_status: commission.payment_status,
        });
      }

      // ------------------------------------------------------
      // 7. UPDATE COMMISSION
      //
      // Conditional update prevents two admins from processing
      // the same submitted commission simultaneously.
      // ------------------------------------------------------

      const newStatus =
        decision === "approved"
          ? "admin_approved"
          : "rejected";

      const {
        data: updatedCommission,
        error: updateError,
      } = await supabaseAdmin
        .from("nasara_marketplace_commissions")
        .update({
          payment_status: newStatus,
          admin_verified_by: adminId,
          admin_verified_at: new Date().toISOString(),
          admin_notes: adminNotes || null,
        })
        .eq("id", commissionId)
        .eq("payment_status", "seller_submitted")
        .select("*")
        .maybeSingle();

      if (updateError) {
        console.error(
          "Commission verification update error:",
          updateError
        );

        return res.status(500).json({
          success: false,
          error: "Unable to update commission verification.",
        });
      }

      if (!updatedCommission) {
        return res.status(409).json({
          success: false,
          error:
            "Another admin may have already processed this payment. Refresh and check the commission status.",
        });
      }

      // ------------------------------------------------------
      // 8. PREPARE SELLER NOTIFICATION
      // ------------------------------------------------------

      const approved = decision === "approved";

      const title = approved
        ? "Nasara Commission Payment Approved"
        : "Nasara Commission Payment Rejected";

      const body = approved
        ? `Your commission payment of ${updatedCommission.currency} ${Number(
            updatedCommission.commission_amount
          ).toFixed(2)} for order ${updatedCommission.order_id} has been verified and approved by Nasara Admin.`
        : `Your commission payment for order ${updatedCommission.order_id} was not approved. Reason: ${adminNotes}`;

      const notificationData = {
        scope: "seller",
        type: "marketplace_commission_decision",
        commission_id: updatedCommission.id,
        order_id: updatedCommission.order_id,
        payment_status: updatedCommission.payment_status,
        decision,
        admin_notes: adminNotes || null,
        url: "/seller/orders",
      };

      // ------------------------------------------------------
      // 9. SAVE IN-APP NOTIFICATION
      // ------------------------------------------------------

      const {
        error: notificationError,
      } = await supabaseAdmin
        .from("notifications")
        .insert({
          user_id: updatedCommission.seller_id,
          sender_id: adminId,
          type: "marketplace_commission_decision",
          title,
          body,
          message: body,
          ref_id: String(updatedCommission.id),
          is_read: false,
          data: notificationData,
        });

      if (notificationError) {
        console.error(
          "Seller in-app notification error:",
          notificationError
        );
      }

      // ------------------------------------------------------
      // 10. SEND ANDROID + BROWSER PUSH
      // ------------------------------------------------------

      const pushResults = await Promise.allSettled([
        notifyUser(
          updatedCommission.seller_id,
          title,
          body,
          notificationData
        ),

        sendBrowserPushToUser(
          updatedCommission.seller_id,
          title,
          body,
          "/seller/orders",
          {
            tag: `marketplace-commission-${updatedCommission.id}`,
            type: "marketplace_commission_decision",
            extraData: notificationData,
          }
        ),
      ]);

      // ------------------------------------------------------
      // 11. RESPONSE
      // ------------------------------------------------------

      return res.status(200).json({
        success: true,
        message: approved
          ? "Commission payment approved successfully."
          : "Commission payment rejected.",
        commission: {
          id: updatedCommission.id,
          order_id: updatedCommission.order_id,
          seller_id: updatedCommission.seller_id,
          commission_amount: updatedCommission.commission_amount,
          currency: updatedCommission.currency,
          payment_status: updatedCommission.payment_status,
          admin_verified_by: updatedCommission.admin_verified_by,
          admin_verified_at: updatedCommission.admin_verified_at,
          admin_notes: updatedCommission.admin_notes,
        },
        notifications: {
          in_app:
            notificationError ? "failed" : "saved",
          android:
            pushResults[0].status === "fulfilled"
              ? "attempted"
              : "failed",
          browser:
            pushResults[1].status === "fulfilled"
              ? "attempted"
              : "failed",
        },
      });

    } catch (error) {
      console.error(
        "NASARA ADMIN COMMISSION VERIFICATION ERROR:",
        error
      );

      return res.status(500).json({
        success: false,
        error:
          "An unexpected error occurred while verifying commission payment.",
      });
    }
  }
);

// ============================================================
// NASARA MARKETPLACE: SELLER ORDER FULFILMENT
// POST /marketplace/orders/:orderId/status
//
// Seller can:
// - Mark order ready for dispatch
// - Mark order dispatched
//
// Buyer receives in-app, Android and browser notifications.
// Buyer confirmation will handle final completion.
// ============================================================

app.post(
  "/marketplace/orders/:orderId/status",
  async (req, res) => {
    try {
      // ------------------------------------------------------
      // 1. AUTHENTICATE SELLER
      // ------------------------------------------------------

      const authHeader = req.headers.authorization || "";
      const token = authHeader.startsWith("Bearer ")
        ? authHeader.slice(7)
        : null;

      if (!token) {
        return res.status(401).json({
          success: false,
          error: "Authentication required.",
        });
      }

      const {
        data: authData,
        error: authError,
      } = await supabaseAdmin.auth.getUser(token);

      if (authError || !authData?.user) {
        return res.status(401).json({
          success: false,
          error: "Invalid or expired session.",
        });
      }

      const sellerId = authData.user.id;
      const orderId = req.params.orderId;

      // ------------------------------------------------------
      // 2. VALIDATE ORDER ID
      // ------------------------------------------------------

      const uuidRegex =
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

      if (!uuidRegex.test(orderId)) {
        return res.status(400).json({
          success: false,
          error: "Invalid order ID.",
        });
      }

      // ------------------------------------------------------
      // 3. VALIDATE REQUESTED STATUS
      // ------------------------------------------------------

      const newStatus = String(
        req.body?.status || ""
      ).trim().toLowerCase();

      const allowedTransitions = {
        processing: "ready_for_dispatch",
        ready_for_dispatch: "dispatched",
      };

      if (
        !Object.values(allowedTransitions).includes(newStatus)
      ) {
        return res.status(400).json({
          success: false,
          error:
            "Invalid status. Seller can mark an order ready_for_dispatch or dispatched.",
        });
      }

      // ------------------------------------------------------
      // 4. FETCH ORDER
      // ------------------------------------------------------

      const {
        data: order,
        error: orderError,
      } = await supabaseAdmin
        .from("nasara_marketplace_orders")
        .select(`
          id,
          order_number,
          buyer_id,
          seller_id,
          total_amount,
          currency,
          payment_status,
          order_status
        `)
        .eq("id", orderId)
        .maybeSingle();

      if (orderError) {
        console.error("Order lookup error:", orderError);

        return res.status(500).json({
          success: false,
          error: "Unable to retrieve order.",
        });
      }

      if (!order) {
        return res.status(404).json({
          success: false,
          error: "Order not found.",
        });
      }

      // ------------------------------------------------------
      // 5. VERIFY SELLER OWNERSHIP
      // ------------------------------------------------------

      if (order.seller_id !== sellerId) {
        return res.status(403).json({
          success: false,
          error: "You are not authorized to update this order.",
        });
      }

      // ------------------------------------------------------
      // 6. VERIFY BUYER PAYMENT
      // ------------------------------------------------------

      if (order.payment_status !== "seller_confirmed") {
        return res.status(409).json({
          success: false,
          error:
            "You must confirm the buyer's payment before fulfilling this order.",
          payment_status: order.payment_status,
        });
      }

      // ------------------------------------------------------
      // 7. VERIFY STATUS TRANSITION
      // ------------------------------------------------------

      const expectedPreviousStatus =
        Object.keys(allowedTransitions).find(
          (status) => allowedTransitions[status] === newStatus
        );

      if (order.order_status !== expectedPreviousStatus) {
        return res.status(409).json({
          success: false,
          error:
            "This order cannot move to the requested status from its current status.",
          current_status: order.order_status,
          requested_status: newStatus,
        });
      }

      // ------------------------------------------------------
      // 8. UPDATE ORDER
      //
      // Conditional update prevents duplicate or conflicting
      // status changes.
      // ------------------------------------------------------

      const {
        data: updatedOrder,
        error: updateError,
      } = await supabaseAdmin
        .from("nasara_marketplace_orders")
        .update({
          order_status: newStatus,
        })
        .eq("id", orderId)
        .eq("seller_id", sellerId)
        .eq("payment_status", "seller_confirmed")
        .eq("order_status", expectedPreviousStatus)
        .select("*")
        .maybeSingle();

      if (updateError) {
        console.error("Order status update error:", updateError);

        return res.status(500).json({
          success: false,
          error: "Unable to update order status.",
        });
      }

      if (!updatedOrder) {
        return res.status(409).json({
          success: false,
          error:
            "The order status has changed. Refresh and try again.",
        });
      }

      // ------------------------------------------------------
      // 9. PREPARE BUYER NOTIFICATION
      // ------------------------------------------------------

      const orderNumber = updatedOrder.order_number;

      const notificationMessages = {
        ready_for_dispatch: {
          title: "Your Nasara Order Is Ready",
          body:
            `Your order #${orderNumber} has been prepared ` +
            "by the seller and is ready for dispatch.",
        },

        dispatched: {
          title: "Your Nasara Order Has Been Dispatched",
          body:
            `Your order #${orderNumber} has been marked as dispatched ` +
            "by the seller.",
        },
      };

      const notification =
        notificationMessages[newStatus];

      const notificationData = {
        scope: "buyer",
        type: "marketplace_order_status",
        order_id: updatedOrder.id,
        order_number: orderNumber,
        seller_id: sellerId,
        order_status: newStatus,
        payment_status: updatedOrder.payment_status,
        url: "/orders",
      };

      // ------------------------------------------------------
      // 10. SAVE BUYER IN-APP NOTIFICATION
      // ------------------------------------------------------

      const {
        error: notificationError,
      } = await supabaseAdmin
        .from("notifications")
        .insert({
          user_id: updatedOrder.buyer_id,
          sender_id: sellerId,
          type: "marketplace_order_status",
          title: notification.title,
          body: notification.body,
          message: notification.body,
          ref_id: String(updatedOrder.id),
          is_read: false,
          data: notificationData,
        });

      if (notificationError) {
        console.error(
          "Buyer in-app notification error:",
          notificationError
        );
      }

      // ------------------------------------------------------
      // 11. SEND ANDROID + BROWSER PUSH
      // ------------------------------------------------------

      const pushResults = await Promise.allSettled([
        notifyUser(
          updatedOrder.buyer_id,
          notification.title,
          notification.body,
          notificationData
        ),

        sendBrowserPushToUser(
          updatedOrder.buyer_id,
          notification.title,
          notification.body,
          "/orders",
          {
            tag: `marketplace-order-${updatedOrder.id}-${newStatus}`,
            type: "marketplace_order_status",
            extraData: notificationData,
          }
        ),
      ]);

      // ------------------------------------------------------
      // 12. RETURN RESULT
      // ------------------------------------------------------

      return res.status(200).json({
        success: true,
        message: notification.body,
        order: {
          id: updatedOrder.id,
          order_number: updatedOrder.order_number,
          payment_status: updatedOrder.payment_status,
          order_status: updatedOrder.order_status,
        },
        notifications: {
          in_app: notificationError ? "failed" : "saved",
          android:
            pushResults[0].status === "fulfilled"
              ? "attempted"
              : "failed",
          browser:
            pushResults[1].status === "fulfilled"
              ? "attempted"
              : "failed",
        },
      });

    } catch (error) {
      console.error(
        "NASARA SELLER ORDER FULFILMENT ERROR:",
        error
      );

      return res.status(500).json({
        success: false,
        error:
          "An unexpected error occurred while updating the order.",
      });
    }
  }
);


// ============================================================
// NASARA MARKETPLACE: BUYER CONFIRMS ORDER RECEIPT
// POST /marketplace/orders/:orderId/confirm-received
//
// Buyer confirms that the ordered products were received.
//
// Changes:
// order_status: dispatched -> completed
//
// Notifications:
// - Seller: in-app + Android + browser push
// - Nasara Admin: in-app + Android + browser push
// ============================================================

app.post(
  "/marketplace/orders/:orderId/confirm-received",
  async (req, res) => {
    try {
      // ------------------------------------------------------
      // 1. AUTHENTICATE BUYER
      // ------------------------------------------------------

      const authHeader = req.headers.authorization || "";
      const token = authHeader.startsWith("Bearer ")
        ? authHeader.slice(7)
        : null;

      if (!token) {
        return res.status(401).json({
          success: false,
          error: "Authentication required.",
        });
      }

      const {
        data: authData,
        error: authError,
      } = await supabaseAdmin.auth.getUser(token);

      if (authError || !authData?.user) {
        return res.status(401).json({
          success: false,
          error: "Invalid or expired session.",
        });
      }

      const buyerId = authData.user.id;
      const orderId = req.params.orderId;

      // ------------------------------------------------------
      // 2. VALIDATE ORDER ID
      // ------------------------------------------------------

      const uuidRegex =
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

      if (!uuidRegex.test(orderId)) {
        return res.status(400).json({
          success: false,
          error: "Invalid order ID.",
        });
      }

      // ------------------------------------------------------
      // 3. FETCH ORDER
      // ------------------------------------------------------

      const {
        data: order,
        error: orderError,
      } = await supabaseAdmin
        .from("nasara_marketplace_orders")
        .select(`
          id,
          order_number,
          buyer_id,
          seller_id,
          total_amount,
          currency,
          payment_status,
          order_status
        `)
        .eq("id", orderId)
        .maybeSingle();

      if (orderError) {
        console.error("Order lookup error:", orderError);

        return res.status(500).json({
          success: false,
          error: "Unable to retrieve order.",
        });
      }

      if (!order) {
        return res.status(404).json({
          success: false,
          error: "Order not found.",
        });
      }

      // ------------------------------------------------------
      // 4. VERIFY BUYER OWNERSHIP
      // ------------------------------------------------------

      if (order.buyer_id !== buyerId) {
        return res.status(403).json({
          success: false,
          error: "You are not authorized to confirm this order.",
        });
      }

      // ------------------------------------------------------
      // 5. VERIFY PAYMENT
      // ------------------------------------------------------

      if (order.payment_status !== "seller_confirmed") {
        return res.status(409).json({
          success: false,
          error:
            "This order cannot be completed because payment has not been confirmed by the seller.",
          payment_status: order.payment_status,
        });
      }

      // ------------------------------------------------------
      // 6. ONLY DISPATCHED ORDERS CAN BE COMPLETED
      // ------------------------------------------------------

      if (order.order_status !== "dispatched") {
        return res.status(409).json({
          success: false,
          error:
            "You can only confirm receipt after the seller has dispatched your order.",
          current_status: order.order_status,
        });
      }

      // ------------------------------------------------------
      // 7. COMPLETE ORDER
      //
      // Conditional update prevents duplicate confirmation
      // and conflicting status changes.
      // ------------------------------------------------------

      const {
        data: completedOrder,
        error: updateError,
      } = await supabaseAdmin
        .from("nasara_marketplace_orders")
        .update({
          order_status: "completed",
        })
        .eq("id", orderId)
        .eq("buyer_id", buyerId)
        .eq("payment_status", "seller_confirmed")
        .eq("order_status", "dispatched")
        .select("*")
        .maybeSingle();

      if (updateError) {
        console.error("Order completion error:", updateError);

        return res.status(500).json({
          success: false,
          error: "Unable to confirm order receipt.",
        });
      }

      if (!completedOrder) {
        return res.status(409).json({
          success: false,
          error:
            "This order has already been updated. Refresh and check its status.",
        });
      }

      // ------------------------------------------------------
      // 8. PREPARE SELLER NOTIFICATION
      // ------------------------------------------------------

      const title = "Order Successfully Completed";

      const body =
        `The buyer has confirmed receiving order ` +
        `#${completedOrder.order_number}. ` +
        "Your Nasara order is now completed.";

      const notificationData = {
        scope: "seller",
        type: "marketplace_order_completed",
        order_id: completedOrder.id,
        order_number: completedOrder.order_number,
        buyer_id: buyerId,
        seller_id: completedOrder.seller_id,
        order_status: "completed",
        payment_status: completedOrder.payment_status,
        url: "/seller/orders",
      };

      // ------------------------------------------------------
      // 9. SAVE SELLER IN-APP NOTIFICATION
      // ------------------------------------------------------

      const {
        error: sellerNotificationError,
      } = await supabaseAdmin
        .from("notifications")
        .insert({
          user_id: completedOrder.seller_id,
          sender_id: buyerId,
          type: "marketplace_order_completed",
          title,
          body,
          message: body,
          ref_id: String(completedOrder.id),
          is_read: false,
          data: notificationData,
        });

      if (sellerNotificationError) {
        console.error(
          "Seller completion notification error:",
          sellerNotificationError
        );
      }

      // ------------------------------------------------------
      // 10. SEND SELLER ANDROID + BROWSER PUSH
      // ------------------------------------------------------

      const sellerPushResults = await Promise.allSettled([
        notifyUser(
          completedOrder.seller_id,
          title,
          body,
          notificationData
        ),

        sendBrowserPushToUser(
          completedOrder.seller_id,
          title,
          body,
          "/seller/orders",
          {
            tag: `marketplace-completed-${completedOrder.id}`,
            type: "marketplace_order_completed",
            extraData: notificationData,
          }
        ),
      ]);

      // ------------------------------------------------------
      // 11. NOTIFY NASARA ADMIN
      // ------------------------------------------------------

      const adminNotification =
        await Promise.allSettled([
          createNasaraAdminNotification({
            type: "marketplace_order_completed",
            title: "Marketplace Order Completed",
            body:
              `Buyer confirmed receipt of order ` +
              `#${completedOrder.order_number}. ` +
              `Order value: ${completedOrder.currency} ` +
              `${Number(completedOrder.total_amount).toFixed(2)}.`,
            ref_id: completedOrder.id,
            sender_id: buyerId,
            priority: "normal",
            data: {
              order_id: completedOrder.id,
              order_number: completedOrder.order_number,
              buyer_id: buyerId,
              seller_id: completedOrder.seller_id,
              order_status: "completed",
              url: "/admin/notifications",
            },
          }),
        ]);

      // ------------------------------------------------------
      // 12. RETURN RESULT
      // ------------------------------------------------------

      return res.status(200).json({
        success: true,
        message:
          "Thank you. You have confirmed receiving your order.",
        order: {
          id: completedOrder.id,
          order_number: completedOrder.order_number,
          payment_status: completedOrder.payment_status,
          order_status: completedOrder.order_status,
        },
        notifications: {
          seller_in_app: sellerNotificationError
            ? "failed"
            : "saved",
          seller_android:
            sellerPushResults[0].status === "fulfilled"
              ? "attempted"
              : "failed",
          seller_browser:
            sellerPushResults[1].status === "fulfilled"
              ? "attempted"
              : "failed",
          admin:
            adminNotification[0].status === "fulfilled"
              ? "notification_helper_completed"
              : "notification_helper_failed",
        },
      });

    } catch (error) {
      console.error(
        "NASARA BUYER ORDER COMPLETION ERROR:",
        error
      );

      return res.status(500).json({
        success: false,
        error:
          "An unexpected error occurred while confirming order receipt.",
      });
    }
  }
);

// ============================================================
// NASARA MARKETPLACE - GET BUYER / SELLER ORDERS
// GET /marketplace/orders?role=buyer
// GET /marketplace/orders?role=seller
//
// Buyers see their purchases.
// Sellers see orders for their products.
// Only sellers receive commission details.
// ============================================================

app.get("/marketplace/orders", async (req, res) => {
  try {
    // 1. Authenticate user
    const authHeader = req.headers.authorization || "";
    const token = authHeader.startsWith("Bearer ")
      ? authHeader.slice(7)
      : null;

    if (!token) {
      return res.status(401).json({
        success: false,
        message: "Authentication required.",
      });
    }

    const {
      data: { user },
      error: authError,
    } = await supabaseAdmin.auth.getUser(token);

    if (authError || !user) {
      return res.status(401).json({
        success: false,
        message: "Invalid or expired session.",
      });
    }

    // 2. Validate requested view
    const role = String(req.query.role || "").toLowerCase();

    if (!["buyer", "seller"].includes(role)) {
      return res.status(400).json({
        success: false,
        message: "Role must be buyer or seller.",
      });
    }

    // 3. Fetch only this user's orders
    let ordersQuery = supabaseAdmin
      .from("nasara_marketplace_orders")
      .select("*")
      .eq(role === "buyer" ? "buyer_id" : "seller_id", user.id)
      .order("created_at", { ascending: false })
      .limit(50);

    // Optional order status filter
    if (req.query.status) {
      ordersQuery = ordersQuery.eq(
        "order_status",
        String(req.query.status)
      );
    }

    const { data: orders, error: ordersError } = await ordersQuery;

    if (ordersError) {
      console.error("Nasara orders fetch error:", ordersError);

      return res.status(500).json({
        success: false,
        message: "Could not retrieve orders.",
      });
    }

    if (!orders || orders.length === 0) {
      return res.json({
        success: true,
        role,
        count: 0,
        orders: [],
      });
    }

    // 4. Fetch order items
    const orderIds = orders.map((order) => order.id);

    const {
      data: orderItems,
      error: itemsError,
    } = await supabaseAdmin
      .from("nasara_marketplace_order_items")
      .select("*")
      .in("order_id", orderIds);

    if (itemsError) {
      console.error("Nasara order items error:", itemsError);

      return res.status(500).json({
        success: false,
        message: "Could not retrieve order items.",
      });
    }

    // 5. Fetch commissions only for the seller
    let commissions = [];

    if (role === "seller") {
      const {
        data: commissionData,
        error: commissionError,
      } = await supabaseAdmin
        .from("nasara_marketplace_commissions")
        .select("*")
        .eq("seller_id", user.id)
        .in("order_id", orderIds);

      if (commissionError) {
        console.error("Nasara commission fetch error:", commissionError);

        return res.status(500).json({
          success: false,
          message: "Could not retrieve commission details.",
        });
      }

      commissions = commissionData || [];
    }

    // 6. Attach items and seller-only commission information
    const result = orders.map((order) => {
      const items = (orderItems || []).filter(
        (item) => item.order_id === order.id
      );

      const commission =
        role === "seller"
          ? commissions.find(
              (item) => item.order_id === order.id
            ) || null
          : undefined;

      return {
        ...order,
        items,
        ...(role === "seller" ? { commission } : {}),
      };
    });

    return res.json({
      success: true,
      role,
      count: result.length,
      orders: result,
    });

  } catch (error) {
    console.error("Nasara marketplace orders error:", error);

    return res.status(500).json({
      success: false,
      message: "Something went wrong while retrieving orders.",
    });
  }
});
/* ================= WEBSITE GENERATOR SUPABASE ADMIN ================= */

const websiteGeneratorAdmin = createClient(
  process.env.WEBSITE_GENERATOR_SUPABASE_URL,
  process.env.WEBSITE_GENERATOR_SUPABASE_SERVICE_ROLE_KEY
);
/* ================= UPLOAD ROUTE ================= */
app.post("/upload", upload.single("file"), async (req, res) => {
  try {
    const file = req.file;

    if (!file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    const fileName = Date.now() + "-" + file.originalname;

    const params = {
      Bucket: process.env.R2_BUCKET,
      Key: fileName,
      Body: file.buffer,
      ContentType: file.mimetype,
    };

    await s3.upload(params).promise();

    const publicUrl = `https://${process.env.R2_PUBLIC_DOMAIN}/${fileName}`;

    return res.json({
      success: true,
      url: publicUrl,
      key: fileName,
    });
  } catch (err) {
    console.log("Upload error:", err);
    return res.status(500).json({
      success: false,
      error: err.message,
    });
  }
});
/* ================= VOICE RECORDING UPLOAD ================= */

app.post(
  "/upload-voice-recording",
  upload.single("file"),
  async (req, res) => {

    try {

      const file = req.file;


      if (!file) {

        return res.status(400).json({

          success:false,

          error:
          "No voice file uploaded"

        });

      }


      // only audio files
      if (!file.mimetype.startsWith("audio")) {

        return res.status(400).json({

          success:false,

          error:
          "Only audio files are allowed"

        });

      }


      const fileName =
        "voice-recordings/" +
        Date.now() +
        "-" +
        file.originalname;



      const params = {

        Bucket:
          process.env.R2_BUCKET,

        Key:
          fileName,

        Body:
          file.buffer,

        ContentType:
          file.mimetype,

      };



      await s3
        .upload(params)
        .promise();



      const publicUrl =
        `https://${process.env.R2_PUBLIC_DOMAIN}/${fileName}`;



      return res.json({

        success:true,

        audio_url:
          publicUrl,

        key:
          fileName,

      });



    } catch(err){


      console.log(
        "Voice upload error:",
        err
      );


      return res.status(500).json({

        success:false,

        error:
          err.message

      });


    }

  }
);

// ============================================================
// 🎵 NASARA REELS — ADMIN MUSIC UPLOAD
// POST /upload-reel-music
// ============================================================

app.post(
  "/upload-reel-music",
  upload.single("file"),
  async (req, res) => {
    try {
      // ==========================================
      // 🔐 1. VERIFY ADMIN AUTHENTICATION
      // ==========================================

      const authorization = req.headers.authorization || "";

      if (!authorization.startsWith("Bearer ")) {
        return res.status(401).json({
          success: false,
          error: "Authentication required.",
        });
      }

      const token = authorization.slice(7).trim();

      const {
        data: authData,
        error: authError,
      } = await supabaseAdmin.auth.getUser(token);

      if (authError || !authData?.user) {
        return res.status(401).json({
          success: false,
          error: "Invalid or expired session.",
        });
      }

      const userId = authData.user.id;

      // ==========================================
      // 🛡️ 2. VERIFY NASARA ADMIN
      // ==========================================

      const {
        data: admin,
        error: adminError,
      } = await supabaseAdmin
        .from("admins")
        .select("user_id")
        .eq("user_id", userId)
        .maybeSingle();

      if (adminError) {
        console.error("MUSIC ADMIN CHECK ERROR:", adminError);

        return res.status(500).json({
          success: false,
          error: "Could not verify administrator permissions.",
        });
      }

      if (!admin) {
        return res.status(403).json({
          success: false,
          error: "Only Nasara administrators can upload music.",
        });
      }

      // ==========================================
      // 📦 3. VALIDATE MUSIC FILE
      // ==========================================

      const file = req.file;

      if (!file) {
        return res.status(400).json({
          success: false,
          error: "Please select an audio file.",
        });
      }

      const allowedAudioTypes = {
        "audio/mpeg": ".mp3",
        "audio/mp3": ".mp3",
        "audio/mp4": ".m4a",
        "audio/x-m4a": ".m4a",
        "audio/aac": ".aac",
        "audio/wav": ".wav",
        "audio/x-wav": ".wav",
        "audio/ogg": ".ogg",
      };

      const extension = allowedAudioTypes[file.mimetype];

      if (!extension) {
        return res.status(400).json({
          success: false,
          error: "Unsupported audio format. Use MP3, M4A, AAC, WAV or OGG.",
        });
      }

      // ==========================================
      // 📝 4. VALIDATE MUSIC DETAILS
      // ==========================================

      const title = String(req.body?.title || "").trim();
      const artist = String(req.body?.artist || "").trim();
      const category = String(req.body?.category || "").trim();

      if (!title || title.length > 150) {
        return res.status(400).json({
          success: false,
          error: "A music title is required (maximum 150 characters).",
        });
      }

      if (artist.length > 150 || category.length > 80) {
        return res.status(400).json({
          success: false,
          error: "Artist or category information is too long.",
        });
      }

      // ==========================================
      // ☁️ 5. UPLOAD AUDIO TO CLOUDFLARE R2
      // ==========================================

      const crypto = require("crypto");

      const fileName =
        `reel-music/${crypto.randomBytes(16).toString("hex")}${extension}`;

      await s3.upload({
        Bucket: process.env.R2_BUCKET,
        Key: fileName,
        Body: file.buffer,
        ContentType: file.mimetype,
      }).promise();

      const audioUrl =
        `https://${process.env.R2_PUBLIC_DOMAIN}/${fileName}`;

      // ==========================================
      // 💾 6. SAVE MUSIC DETAILS IN SUPABASE
      // ==========================================

      const {
        data: music,
        error: musicError,
      } = await supabaseAdmin
        .from("reel_music")
        .insert({
          title,
          artist: artist || null,
          category: category || null,
          audio_url: audioUrl,
          is_active: true,
        })
        .select("*")
        .single();

      if (musicError) {
        console.error("MUSIC DATABASE ERROR:", musicError);

        // Remove uploaded audio if database insertion fails.
        try {
          await s3.deleteObject({
            Bucket: process.env.R2_BUCKET,
            Key: fileName,
          }).promise();
        } catch (deleteError) {
          console.error("R2 CLEANUP ERROR:", deleteError);
        }

        return res.status(500).json({
          success: false,
          error: "Audio uploaded, but music details could not be saved.",
        });
      }

      // ==========================================
      // ✅ 7. RETURN SUCCESS
      // ==========================================

      console.log("🎵 REEL MUSIC UPLOADED:", {
        musicId: music.id,
        title: music.title,
      });

      return res.status(201).json({
        success: true,
        message: "Music uploaded successfully.",
        music,
      });

    } catch (error) {
      console.error("🎵 REEL MUSIC UPLOAD ERROR:", error);

      return res.status(500).json({
        success: false,
        error: "Could not upload Reel music.",
      });
    }
  }
);


/* ================= CREATE ADMIN ================= */
app.post("/create-admin", async (req, res) => {
  try {
    const { email,password, full_name, system } = req.body;
    

    if (!email || !full_name || !system) {
      return res.status(400).json({
        error: "Missing required fields",
      });
    }

    const tables = {
      nasara: "admins",
      coalition: "coalition_admins",
      utilities: "utility_admins",
    };

    const table = tables[system];

    if (!table) {
      return res.status(400).json({
        error: "Invalid system",
      });
    }

    let userId;
    let existingUser = false;

    /* ================= CREATE USER ================= */
    const { data: authData, error: authError } =
     await supabaseAdmin.auth.admin.createUser({
  email,
  password,
  email_confirm: true,
});

    if (authData?.user) {
      userId = authData.user.id;
    }

    /* ================= USER EXISTS ================= */
    if (authError) {
      const msg = authError.message?.toLowerCase() || "";

      if (msg.includes("already") || msg.includes("exists")) {
        existingUser = true;

        const { data, error } =
          await supabaseAdmin.auth.admin.listUsers({
            page: 1,
            perPage: 1000,
          });

        if (error) {
          return res.status(400).json({
            error: error.message,
          });
        }

        const found = data.users.find(
          (u) => u.email?.toLowerCase() === email.toLowerCase()
        );

        if (!found) {
          return res.status(400).json({
            error: "User exists but cannot be located",
          });
        }

        userId = found.id;
      } else {
        return res.status(400).json({
          error: authError.message,
        });
      }
    }

    if (!userId) {
      return res.status(400).json({
        error: "User ID not resolved",
      });
    }

    /* ================= CHECK ADMIN ================= */
    const { data: existingAdmin } = await supabaseAdmin
      .from(table)
      .select("user_id")
      .eq("user_id", userId)
      .maybeSingle();

    if (existingAdmin) {
      return res.status(400).json({
        error: "User is already an admin",
      });
    }

    /* ================= INSERT ================= */
    const { error: insertError } = await supabaseAdmin
      .from(table)
      .insert({
        user_id: userId,
        full_name,
        role: "admin",
      });

    if (insertError) {
      return res.status(400).json({
        error: insertError.message,
      });
    }

    return res.json({
      success: true,
      user_id: userId,
      existing_user: existingUser,
      system,
    });

  } catch (err) {
    console.error("CREATE ADMIN ERROR:", err);

    return res.status(500).json({
      error: err?.message || "Server error",
      details: err,
    });
  }
});

/* ================= CREATE RESTAURANT OWNER ================= */

app.post("/create-restaurant-owner", async (req, res) => {
  try {
    const {
      email,
      full_name,
      phone,
      password,
    } = req.body;

    // =====================================================
    // VALIDATION
    // =====================================================

    if (!email || !full_name) {
      return res.status(400).json({
        success: false,
        error: "Email and full name are required",
      });
    }

    const normalizedEmail =
      String(email).trim().toLowerCase();

    const normalizedName =
      String(full_name).trim();

    const normalizedPhone =
      phone
        ? String(phone).trim()
        : null;

    if (!normalizedEmail || !normalizedName) {
      return res.status(400).json({
        success: false,
        error: "Email and full name are required",
      });
    }

    // =====================================================
    // PASSWORD
    //
    // Existing Nasara users do NOT need a new password.
    //
    // New users need a password supplied by admin.
    // =====================================================

    let newUserPassword = password
      ? String(password)
      : null;

    if (
      newUserPassword &&
      newUserPassword.length < 6
    ) {
      return res.status(400).json({
        success: false,
        error:
          "Password must be at least 6 characters",
      });
    }

    // =====================================================
    // FIND EXISTING NASARA AUTH USER
    //
    // We use listUsers because the Supabase admin API
    // does not provide a reliable getUserByEmail method
    // across all versions.
    // =====================================================

    const {
      data: usersData,
      error: usersError,
    } =
      await supabaseAdmin.auth.admin.listUsers({
        page: 1,
        perPage: 1000,
      });

    if (usersError) {
      console.error(
        "RESTAURANT OWNER USER LOOKUP ERROR:",
        usersError
      );

      return res.status(500).json({
        success: false,
        error:
          "Unable to check existing Nasara users: " +
          usersError.message,
      });
    }

    const existingAuthUser =
      usersData?.users?.find(
        (user) =>
          user.email?.toLowerCase() ===
          normalizedEmail
      );

    let userId = null;
    let existingUser = false;
    let createdUser = false;

    // =====================================================
    // EXISTING NASARA USER
    // =====================================================

    if (existingAuthUser) {
      existingUser = true;

      userId = existingAuthUser.id;

      console.log(
        "EXISTING NASARA USER FOUND:",
        userId
      );

    } else {

      // ===================================================
      // NEW NASARA USER
      // ===================================================

      if (!newUserPassword) {
        return res.status(400).json({
          success: false,
          error:
            "Password is required when creating a new Nasara user.",
        });
      }

      const {
        data: authData,
        error: authError,
      } =
        await supabaseAdmin.auth.admin.createUser({
          email:
            normalizedEmail,

          password:
            newUserPassword,

          email_confirm:
            true,

          user_metadata: {
            full_name:
              normalizedName,
          },
        });

      if (authError) {
        console.error(
          "CREATE RESTAURANT OWNER AUTH ERROR:",
          authError
        );

        return res.status(400).json({
          success: false,
          error:
            authError.message,
        });
      }

      if (!authData?.user) {
        return res.status(500).json({
          success: false,
          error:
            "Nasara Auth user was not created.",
        });
      }

      userId =
        authData.user.id;

      createdUser = true;

      console.log(
        "NEW NASARA USER CREATED:",
        userId
      );
    }

    // =====================================================
    // SAFETY CHECK
    // =====================================================

    if (!userId) {
      return res.status(400).json({
        success: false,
        error:
          "Unable to determine Nasara user ID.",
      });
    }

    // =====================================================
    // ENSURE NASARA PROFILE EXISTS
    //
    // Your actual table is public.profiles.
    // profiles.id = auth.users.id
    // =====================================================

    const {
      data: existingProfile,
      error: profileCheckError,
    } =
      await supabaseAdmin
        .from("profiles")
        .select("id, full_name, phone")
        .eq("id", userId)
        .maybeSingle();

    if (profileCheckError) {
      console.error(
        "PROFILE CHECK ERROR:",
        profileCheckError
      );

      // If we created the Auth user but cannot continue,
      // clean it up.
      if (createdUser) {
        await supabaseAdmin.auth.admin.deleteUser(
          userId
        );
      }

      return res.status(500).json({
        success: false,
        error:
          profileCheckError.message,
      });
    }

    // =====================================================
    // CREATE OR UPDATE NASARA PROFILE
    // =====================================================

    if (existingProfile) {

      const profileUpdate = {
        full_name:
          normalizedName,
      };

      if (normalizedPhone) {
        profileUpdate.phone =
          normalizedPhone;
      }

      const {
        error: profileUpdateError,
      } =
        await supabaseAdmin
          .from("profiles")
          .update(profileUpdate)
          .eq("id", userId);

      if (profileUpdateError) {
        console.error(
          "PROFILE UPDATE ERROR:",
          profileUpdateError
        );

        if (createdUser) {
          await supabaseAdmin.auth.admin.deleteUser(
            userId
          );
        }

        return res.status(500).json({
          success: false,
          error:
            profileUpdateError.message,
        });
      }

    } else {

      const profileInsert = {
        id:
          userId,

        full_name:
          normalizedName,

        phone:
          normalizedPhone,
      };

      const {
        error: profileInsertError,
      } =
        await supabaseAdmin
          .from("profiles")
          .insert(profileInsert);

      if (profileInsertError) {
        console.error(
          "PROFILE INSERT ERROR:",
          profileInsertError
        );

        if (createdUser) {
          await supabaseAdmin.auth.admin.deleteUser(
            userId
          );
        }

        return res.status(500).json({
          success: false,
          error:
            profileInsertError.message,
        });
      }
    }

    // =====================================================
    // CHECK EXISTING RESTAURANT OWNER ACCESS
    // =====================================================

    const {
      data: existingRestaurantOwner,
      error:
        restaurantOwnerCheckError,
    } =
      await supabaseAdmin
        .from("restaurant_owners")
        .select(`
          id,
          user_id,
          restaurant_id,
          status
        `)
        .eq(
          "user_id",
          userId
        )
        .maybeSingle();

    if (restaurantOwnerCheckError) {
      console.error(
        "RESTAURANT OWNER CHECK ERROR:",
        restaurantOwnerCheckError
      );

      if (createdUser) {
        await supabaseAdmin.auth.admin.deleteUser(
          userId
        );
      }

      return res.status(500).json({
        success: false,
        error:
          restaurantOwnerCheckError.message,
      });
    }

    // =====================================================
    // ALREADY RESTAURANT OWNER
    // =====================================================

    if (existingRestaurantOwner) {
      return res.status(409).json({
        success: false,

        error:
          "This Nasara user is already a restaurant owner.",

        already_owner:
          true,

        existing_user:
          existingUser,

        user_id:
          userId,

        restaurant_owner_id:
          existingRestaurantOwner.id,

        restaurant_id:
          existingRestaurantOwner.restaurant_id,

        status:
          existingRestaurantOwner.status,
      });
    }

    // =====================================================
    // CREATE RESTAURANT OWNER ACCESS
    //
    // restaurant_id is NULL for now.
    //
    // The owner will create the restaurant from the
    // Restaurant Dashboard.
    // =====================================================

    const {
      data: restaurantOwner,
      error:
        restaurantOwnerInsertError,
    } =
      await supabaseAdmin
        .from("restaurant_owners")
        .insert({
          user_id:
            userId,

          restaurant_id:
            null,

          status:
            "active",
        })
        .select()
        .single();

    if (restaurantOwnerInsertError) {
      console.error(
        "RESTAURANT OWNER INSERT ERROR:",
        restaurantOwnerInsertError
      );

      // If this was a newly created account,
      // clean up Auth so we don't leave an incomplete account.
      if (createdUser) {
        await supabaseAdmin.auth.admin.deleteUser(
          userId
        );
      }

      return res.status(500).json({
        success: false,
        error:
          restaurantOwnerInsertError.message,
      });
    }

    // =====================================================
    // SUCCESS
    // =====================================================

    console.log(
      "RESTAURANT OWNER CREATED SUCCESSFULLY:",
      {
        user_id:
          userId,

        restaurant_owner_id:
          restaurantOwner.id,

        existing_user:
          existingUser,

        created_user:
          createdUser,
      }
    );

    return res.status(
      createdUser ? 201 : 200
    ).json({
      success: true,

      user_id:
        userId,

      restaurant_owner_id:
        restaurantOwner.id,

      restaurant_id:
        null,

      existing_user:
        existingUser,

      created_user:
        createdUser,

      full_name:
        normalizedName,

      email:
        normalizedEmail,

      message:
        existingUser
          ? "Existing Nasara user has been added as a restaurant owner."
          : "New Nasara user and restaurant owner account created successfully.",
    });

  } catch (err) {

    console.error(
      "CREATE RESTAURANT OWNER ERROR:",
      err
    );

    return res.status(500).json({
      success: false,
      error:
        err?.message ||
        "Internal server error",
    });
  }
});

/* ================= CREATE CONSTITUENCY ADMIN ================= */
app.post("/create-constituency-admin", async (req, res) => {
  try {
    const { email, full_name, constituency } = req.body;
    const temporaryPassword =
  Math.random().toString(36).slice(-8) +
  Math.floor(Math.random() * 100);
    if (!email || !full_name || !constituency) {
  return res.status(400).json({ error: "Missing fields" });
}
    // 1. active election
    const { data: election, error: electionError } = await supabaseAdmin
      .from("election")
      .select("id")
      .eq("status", "active")
      .single();

    if (electionError || !election) {
      return res.status(400).json({ error: "No active election" });
    }

    let constituencyRow;

    // 2. check if constituency exists
    const { data: existing } = await supabaseAdmin
      .from("constituencies")
      .select("id, name")
      .ilike("name", constituency.trim())
      .maybeSingle();

    // 3. IF EXISTS → use it
    if (existing) {
      constituencyRow = existing;
    } 
    // 4. IF NOT EXISTS → CREATE NEW
    else {
      const { data: newConstituency, error: createError } =
        await supabaseAdmin
          .from("constituencies")
          .insert({
            name: constituency.trim(),
          })
          .select("id, name")
          .single();

      if (createError) {
        return res.status(400).json({ error: createError.message });
      }

      constituencyRow = newConstituency;
    }

    // 5. create auth user
    const { data: authData, error: authError } =
      await supabaseAdmin.auth.admin.createUser({
  email,
  password: temporaryPassword,
  email_confirm: true,
});

    if (authError) {
      return res.status(400).json({ error: authError.message });
    }

    const userId = authData.user.id;

    // 6. insert constituency admin
    const { error: insertError } = await supabaseAdmin
      .from("constituency_admins")
      .insert({
        user_id: userId,
        full_name,
        email,
        constituency: constituencyRow.name,
        constituency_id: constituencyRow.id,
        election_id: election.id,
        active: true,
        must_change_password: true,
      });

    if (insertError) {
      return res.status(400).json({ error: insertError.message });
    }

    return res.json({
      success: true,
      user_id: userId,
       temporary_password: temporaryPassword,
      constituency_id: constituencyRow.id,
      election_id: election.id,
    });
  } catch (err) {
    return res.status(500).json({ error: "Server error" });
  }
});
/* ================= CREATE PARTY USER ================= */
app.post("/create-party-user", async (req, res) => {
  try {
    const {
      email,
      full_name,
      phone,
      role,
      status,
      party_id,
    } = req.body;
const temporaryPassword =
  Math.random().toString(36).slice(-8) +
  Math.floor(Math.random() * 100);
    // Basic validation
    if (!email || !full_name || !role) {
      return res.status(400).json({
        error: "Missing required fields",
      });
    }

    // Only Data Entry Officers MUST belong to a party
    if (role === "data_entry" && !party_id) {
      return res.status(400).json({
        error: "Party is required for Data Entry Officers.",
      });
    }

    let userId;
    let existingUser = false;

    // Create auth user
    const { data: authData, error: authError } =
      await supabaseAdmin.auth.admin.createUser({
  email,
  password: temporaryPassword,
  email_confirm: true,
});

    if (authData?.user) {
      userId = authData.user.id;
    }

    // Existing auth user
    if (authError) {
      const msg = authError.message?.toLowerCase() || "";

      if (
        msg.includes("already") ||
        msg.includes("exists")
      ) {
        existingUser = true;

        const { data, error } =
          await supabaseAdmin.auth.admin.listUsers({
            page: 1,
            perPage: 1000,
          });

        if (error) {
          return res.status(400).json({
            error: error.message,
          });
        }

        const found = data.users.find(
          (u) =>
            u.email?.toLowerCase() ===
            email.toLowerCase()
        );

        if (!found) {
          return res.status(400).json({
            error: "Existing user not found",
          });
        }

        userId = found.id;
      } else {
        return res.status(400).json({
          error: authError.message,
        });
      }
    }

    if (!userId) {
      return res.status(400).json({
        error: "Unable to resolve user.",
      });
    }

    // Existing profile?
    const { data: existingProfile } =
      await supabaseAdmin
        .from("users")
        .select("id")
        .eq("auth_user_id", userId)
        .maybeSingle();

    const payload = {
      auth_user_id: userId,
      full_name,
      phone: phone || null,
      email,
      role,
      status,
      party_id:
        role === "party_manager"
          ? null
          : party_id,
    };

    if (existingProfile) {
      const { error } = await supabaseAdmin
        .from("users")
        .update(payload)
        .eq("auth_user_id", userId);

      if (error) {
        return res.status(400).json({
          error: error.message,
        });
      }
    } else {
      const { error } = await supabaseAdmin
        .from("users")
        .insert(payload);

      if (error) {
        return res.status(400).json({
          error: error.message,
        });
      }
    }

    return res.json({
  success: true,
  user_id: userId,
  temporary_password: temporaryPassword,
  existing_user: existingUser,
});
  } catch (err) {
    console.log(err);

    return res.status(500).json({
      error: err.message,
    });
  }
});
/* ================= CREATE BUSINESS OWNER ================= */

app.post("/create-business-owner", async (req, res) => {
  let createdAuthUserId = null;
  let createdBusinessOwnerId = null;

  try {
    const {
      email,
      full_name,
      company_name,
      website_id,
    } = req.body;

    // ==================================================
    // VALIDATION
    // ==================================================

    if (
      !email ||
      !full_name ||
      !company_name ||
      !website_id
    ) {
      return res.status(400).json({
        error:
          "Email, full name, company name, and website ID are required.",
      });
    }

    const normalizedEmail =
      String(email).trim().toLowerCase();

    const normalizedName =
      String(full_name).trim();

    const normalizedCompanyName =
      String(company_name).trim();

    const normalizedWebsiteId =
      String(website_id).trim();

    if (
      !normalizedEmail ||
      !normalizedName ||
      !normalizedCompanyName ||
      !normalizedWebsiteId
    ) {
      return res.status(400).json({
        error:
          "Email, full name, company name, and website ID are required.",
      });
    }

    // ==================================================
    // GENERATE TEMPORARY PASSWORD
    // ==================================================

    const temporaryPassword =
      Math.random()
        .toString(36)
        .slice(-8) +
      Math.floor(
        1000 + Math.random() * 9000
      );

    let userId = null;
    let existingUser = false;

    // ==================================================
    // CHECK WEBSITE
    // ==================================================

    console.log(
      "Checking website:",
      normalizedWebsiteId
    );

    const {
      data: website,
      error: websiteError,
    } =
      await websiteGeneratorAdmin
        .from("websites")
        .select(
          "id,name,website_type,status,owner_id,owner_email,handed_over"
        )
        .eq(
          "id",
          normalizedWebsiteId
        )
        .maybeSingle();

    if (websiteError) {
      console.error(
        "WEBSITE LOOKUP ERROR:",
        websiteError
      );

      return res.status(500).json({
        error:
          "The server could not access the websites table.",
        details:
          websiteError.message,
        code:
          websiteError.code || null,
        hint:
          websiteError.hint || null,
      });
    }

    if (!website) {
      return res.status(404).json({
        error:
          "Website not found. Please refresh the Business Owner page and select the website again.",
      });
    }

    // ==================================================
    // CHECK IF WEBSITE ALREADY HAS OWNER
    // ==================================================

    if (website.owner_id) {
      return res.status(400).json({
        error:
          "This website already has a business owner.",
      });
    }

    if (website.handed_over) {
      return res.status(400).json({
        error:
          "This website has already been handed over.",
      });
    }

    // ==================================================
    // CHECK IF AUTH USER ALREADY EXISTS
    // ==================================================

    console.log(
      "Checking existing Auth user:",
      normalizedEmail
    );

    const {
      data: usersData,
      error: usersError,
    } =
      await websiteGeneratorAdmin.auth.admin.listUsers({
        page: 1,
        perPage: 1000,
      });

    if (usersError) {
      console.error(
        "AUTH USER LOOKUP ERROR:",
        usersError
      );

      return res.status(500).json({
        error:
          "Unable to check existing Auth users.",
        details:
          usersError.message,
      });
    }

    const existingAuthUser =
      usersData?.users?.find(
        (user) =>
          user.email?.toLowerCase() ===
          normalizedEmail
      );

    // ==================================================
    // EXISTING AUTH USER
    // ==================================================

    if (existingAuthUser) {
      existingUser = true;

      userId =
        existingAuthUser.id;

      console.log(
        "Existing Auth user found:",
        userId
      );

      // ------------------------------------------------
      // Check whether this Auth user already belongs
      // to a Business Owner account.
      // ------------------------------------------------

      const {
        data: existingOwner,
        error: existingOwnerError,
      } =
        await websiteGeneratorAdmin
          .from("business_owners")
          .select(
            "id,website_id,company_name,status"
          )
          .eq(
            "auth_user_id",
            userId
          )
          .maybeSingle();

      if (existingOwnerError) {
        console.error(
          "EXISTING OWNER LOOKUP ERROR:",
          existingOwnerError
        );

        return res.status(500).json({
          error:
            "Unable to check the existing Business Owner record.",
          details:
            existingOwnerError.message,
        });
      }

      if (existingOwner) {
        return res.status(400).json({
          error:
            "This user is already a Business Owner.",
        });
      }

      // ------------------------------------------------
      // Reset password
      // ------------------------------------------------

      const {
        error: updatePasswordError,
      } =
        await websiteGeneratorAdmin.auth.admin.updateUserById(
          userId,
          {
            password:
              temporaryPassword,

            user_metadata: {
              full_name:
                normalizedName,
            },
          }
        );

      if (updatePasswordError) {
        console.error(
          "PASSWORD RESET ERROR:",
          updatePasswordError
        );

        return res.status(400).json({
          error:
            "Unable to set the temporary password.",
          details:
            updatePasswordError.message,
        });
      }
    }

    // ==================================================
    // CREATE NEW AUTH USER
    // ==================================================

    if (!userId) {
      console.log(
        "Creating new Auth user:",
        normalizedEmail
      );

      const {
        data: authData,
        error: authError,
      } =
        await websiteGeneratorAdmin.auth.admin.createUser({
          email:
            normalizedEmail,

          password:
            temporaryPassword,

          email_confirm:
            true,

          user_metadata: {
            full_name:
              normalizedName,
          },
        });

      if (authError) {
        console.error(
          "AUTH CREATE ERROR:",
          authError
        );

        return res.status(400).json({
          error:
            authError.message,
        });
      }

      if (!authData?.user) {
        return res.status(400).json({
          error:
            "Auth user could not be created.",
        });
      }

      userId =
        authData.user.id;

      createdAuthUserId =
        userId;

      console.log(
        "New Auth user created:",
        userId
      );
    }

    // ==================================================
    // CHECK WEBSITE OWNER AGAIN
    // ==================================================

    const {
      data: existingWebsiteOwner,
      error: existingWebsiteOwnerError,
    } =
      await websiteGeneratorAdmin
        .from("business_owners")
        .select(
          "id,auth_user_id,email"
        )
        .eq(
          "website_id",
          normalizedWebsiteId
        )
        .maybeSingle();

    if (existingWebsiteOwnerError) {
      console.error(
        "WEBSITE OWNER LOOKUP ERROR:",
        existingWebsiteOwnerError
      );

      // Roll back newly created Auth user
      if (createdAuthUserId) {
        await websiteGeneratorAdmin.auth.admin.deleteUser(
          createdAuthUserId
        );
      }

      return res.status(500).json({
        error:
          "Unable to check whether this website already has an owner.",
        details:
          existingWebsiteOwnerError.message,
      });
    }

    if (existingWebsiteOwner) {
      // Roll back newly created Auth user
      if (createdAuthUserId) {
        await websiteGeneratorAdmin.auth.admin.deleteUser(
          createdAuthUserId
        );
      }

      return res.status(400).json({
        error:
          "This website already has a business owner.",
      });
    }

    // ==================================================
    // CREATE BUSINESS OWNER RECORD
    // ==================================================

    console.log(
      "Creating Business Owner record..."
    );

    const {
      data: businessOwner,
      error: insertError,
    } =
      await websiteGeneratorAdmin
        .from("business_owners")
        .insert({
          auth_user_id:
            userId,

          website_id:
            normalizedWebsiteId,

          company_name:
            normalizedCompanyName,

          full_name:
            normalizedName,

          email:
            normalizedEmail,

          must_change_password:
            true,

          status:
            "active",
        })
        .select()
        .single();

    if (insertError) {
      console.error(
        "BUSINESS OWNER INSERT ERROR:",
        insertError
      );

      // Roll back newly created Auth user
      if (createdAuthUserId) {
        await websiteGeneratorAdmin.auth.admin.deleteUser(
          createdAuthUserId
        );
      }

      return res.status(400).json({
        error:
          "Unable to create the Business Owner record.",
        details:
          insertError.message,
      });
    }

    createdBusinessOwnerId =
      businessOwner.id;

    // ==================================================
    // CONNECT OWNER TO WEBSITE
    // ==================================================

    console.log(
      "Assigning Business Owner to website..."
    );

    const {
      data: updatedWebsite,
      error: websiteUpdateError,
    } =
      await websiteGeneratorAdmin
        .from("websites")
        .update({
          owner_id:
            userId,

          owner_email:
            normalizedEmail,

          handed_over:
            true,

          handed_over_at:
            new Date().toISOString(),

          updated_at:
            new Date().toISOString(),
        })
        .eq(
          "id",
          normalizedWebsiteId
        )
        .select(
          "id,name,owner_id,owner_email,handed_over"
        )
        .maybeSingle();

    if (websiteUpdateError) {
      console.error(
        "WEBSITE UPDATE ERROR:",
        websiteUpdateError
      );

      // Roll back Business Owner record
      if (createdBusinessOwnerId) {
        await websiteGeneratorAdmin
          .from("business_owners")
          .delete()
          .eq(
            "id",
            createdBusinessOwnerId
          );
      }

      // Roll back newly created Auth user
      if (createdAuthUserId) {
        await websiteGeneratorAdmin.auth.admin.deleteUser(
          createdAuthUserId
        );
      }

      return res.status(400).json({
        error:
          "Business Owner was not assigned because the website could not be updated.",
        details:
          websiteUpdateError.message,
      });
    }

    if (!updatedWebsite) {
      console.error(
        "Website update returned no record."
      );

      // Roll back Business Owner record
      if (createdBusinessOwnerId) {
        await websiteGeneratorAdmin
          .from("business_owners")
          .delete()
          .eq(
            "id",
            createdBusinessOwnerId
          );
      }

      // Roll back newly created Auth user
      if (createdAuthUserId) {
        await websiteGeneratorAdmin.auth.admin.deleteUser(
          createdAuthUserId
        );
      }

      return res.status(400).json({
        error:
          "The website could not be confirmed after owner assignment.",
      });
    }

    // ==================================================
    // SUCCESS
    // ==================================================

    console.log(
      "Business Owner successfully created:",
      {
        userId,
        businessOwnerId:
          businessOwner.id,
        websiteId:
          normalizedWebsiteId,
      }
    );

    return res.json({
      success:
        true,

      user_id:
        userId,

      business_owner_id:
        businessOwner.id,

      website_id:
        normalizedWebsiteId,

      website_name:
        website.name,

      company_name:
        normalizedCompanyName,

      full_name:
        normalizedName,

      email:
        normalizedEmail,

      role:
        "business_owner",

      existing_user:
        existingUser,

      must_change_password:
        true,

      temporary_password:
        temporaryPassword,

      message:
        existingUser
          ? "Existing Auth user has been assigned as the Business Owner with a new temporary password."
          : "Business Owner account created successfully with a temporary password.",
    });

  } catch (err) {
    console.error(
      "CREATE BUSINESS OWNER UNEXPECTED ERROR:",
      err
    );

    // ==================================================
    // EMERGENCY ROLLBACK
    // ==================================================

    try {
      if (createdBusinessOwnerId) {
        await websiteGeneratorAdmin
          .from("business_owners")
          .delete()
          .eq(
            "id",
            createdBusinessOwnerId
          );
      }

      if (createdAuthUserId) {
        await websiteGeneratorAdmin.auth.admin.deleteUser(
          createdAuthUserId
        );
      }
    } catch (rollbackError) {
      console.error(
        "ROLLBACK ERROR:",
        rollbackError
      );
    }

    return res.status(500).json({
      error:
        err?.message ||
        "Internal server error.",
    });
  }
});
/* ================= CREATE HUB360 ADMIN ================= */

app.post("/create-hub360-admin", async (req, res) => {
  try {
    const {
      email,
      full_name,
    } = req.body;

    // ==================================================
    // VALIDATION
    // ==================================================

    if (!email || !full_name) {
      return res.status(400).json({
        error: "Email and full name are required",
      });
    }

    const normalizedEmail =
      email.trim().toLowerCase();

    const normalizedName =
      full_name.trim();

    if (!normalizedEmail || !normalizedName) {
      return res.status(400).json({
        error: "Email and full name are required",
      });
    }

    // ==================================================
    // GENERATE TEMPORARY PASSWORD
    // ==================================================

    const temporaryPassword =
      Math.random()
        .toString(36)
        .slice(-8) +
      Math.floor(
        1000 + Math.random() * 9000
      );

    let userId = null;
    let existingUser = false;

    // ==================================================
    // CHECK IF AUTH USER ALREADY EXISTS
    // ==================================================

    const {
      data: usersData,
      error: usersError,
    } =
      await supabaseAdmin.auth.admin.listUsers({
        page: 1,
        perPage: 1000,
      });

    if (usersError) {
      return res.status(400).json({
        error:
          "Unable to check existing users: " +
          usersError.message,
      });
    }

    const existingAuthUser =
      usersData.users.find(
        (user) =>
          user.email?.toLowerCase() ===
          normalizedEmail
      );

    // ==================================================
    // EXISTING AUTH USER
    // ==================================================

    if (existingAuthUser) {
      existingUser = true;

      userId = existingAuthUser.id;

      // ------------------------------------------------
      // IMPORTANT:
      // Reset the existing user's password to the newly
      // generated temporary password.
      // ------------------------------------------------

      const {
        error: updatePasswordError,
      } =
        await supabaseAdmin.auth.admin.updateUserById(
          userId,
          {
            password:
              temporaryPassword,
          }
        );

      if (updatePasswordError) {
        return res.status(400).json({
          error:
            "Unable to set temporary password: " +
            updatePasswordError.message,
        });
      }
    }

    // ==================================================
    // CREATE NEW AUTH USER
    // ==================================================

    if (!userId) {
      const {
        data: authData,
        error: authError,
      } =
        await supabaseAdmin.auth.admin.createUser({
          email: normalizedEmail,

          password:
            temporaryPassword,

          email_confirm: true,
        });

      if (authError) {
        return res.status(400).json({
          error:
            authError.message,
        });
      }

      if (!authData?.user) {
        return res.status(400).json({
          error:
            "Auth user could not be created.",
        });
      }

      userId =
        authData.user.id;
    }

    // ==================================================
    // CHECK IF ALREADY HUB360 ADMIN
    // ==================================================

    const {
      data: existingAdmin,
      error: existingAdminError,
    } =
      await supabaseAdmin
        .from("hub360_admins")
        .select("id, role")
        .eq(
          "auth_user_id",
          userId
        )
        .maybeSingle();

    if (existingAdminError) {
      return res.status(400).json({
        error:
          existingAdminError.message,
      });
    }

    if (existingAdmin) {
      return res.status(400).json({
        error:
          "This user is already a Hub360 admin.",
      });
    }

    // ==================================================
    // CREATE INSTITUTION ADMIN PROFILE
    // ==================================================

    const {
      data: admin,
      error: insertError,
    } =
      await supabaseAdmin
        .from("hub360_admins")
        .insert({
          auth_user_id:
            userId,

          full_name:
            normalizedName,

          email:
            normalizedEmail,

          role:
            "institution_admin",

          must_change_password:
            true,

          institution_id:
            null,
        })
        .select()
        .single();

    if (insertError) {
      return res.status(400).json({
        error:
          insertError.message,
      });
    }

    // ==================================================
    // SUCCESS
    // ==================================================

    return res.json({
      success: true,

      user_id:
        userId,

      admin_id:
        admin.id,

      full_name:
        normalizedName,

      email:
        normalizedEmail,

      role:
        "institution_admin",

      existing_user:
        existingUser,

      temporary_password:
        temporaryPassword,

      message:
        existingUser
          ? "Existing Auth user has been promoted to Institution Admin and assigned a new temporary password."
          : "Institution Admin account created successfully with a temporary password.",
    });

  } catch (err) {
    console.error(
      "CREATE HUB360 ADMIN ERROR:",
      err
    );

    return res.status(500).json({
      error:
        err?.message ||
        "Internal server error",
    });
  }
});
/* ================= CREATE HUB360 USER ================= */
app.post("/create-hub360-user", async (req, res) => {
  try {
    const {
      email,
      full_name,
      role,
      institution_id,
      group_id,
      phone,
     employee_or_student_id,
department_id,
role_id,
    } = req.body;

    const temporaryPassword =
      Math.random().toString(36).slice(-8) +
      Math.floor(Math.random() * 100);

    // =====================================================
    // VALIDATION
    // =====================================================

    if (
      !email ||
      !full_name ||
      !role ||
      !institution_id
    ) {
      return res.status(400).json({
        error: "Missing required fields",
      });
    }

    // =====================================================
    // NORMALIZE ROLE
    // =====================================================

    const normalizedRole =
      String(role).trim().toLowerCase();

    // =====================================================
    // CLASS NAME
    //
    // For students, get the selected group's name.
    //
    // Example:
    // group_id -> "JHS 1 A"
    //
    // Then save:
    // hub_users.class_name = "JHS 1 A"
    // =====================================================

    let className = null;

    if (
      normalizedRole === "student" &&
      group_id
    ) {
      const {
        data: group,
        error: groupError,
      } = await supabaseAdmin
        .from("hub_groups")
        .select(`
          id,
          name,
          institution_id,
          type,
          category
        `)
        .eq("id", group_id)
        .eq(
          "institution_id",
          institution_id
        )
        .maybeSingle();

      if (groupError) {
        console.log(
          "GROUP LOOKUP ERROR:",
          groupError
        );

        return res.status(400).json({
          error:
            "Unable to find selected class: " +
            groupError.message,
        });
      }

      if (!group) {
        return res.status(400).json({
          error:
            "Selected class was not found for this institution.",
        });
      }

      className = group.name;

      console.log(
        "SELECTED STUDENT CLASS:",
        {
          group_id,
          class_name: className,
        }
      );
    }

    // =====================================================
    // USER ID
    // =====================================================

    let userId;
    let existingUser = false;

    // =====================================================
    // CREATE AUTH USER
    // =====================================================

    const {
      data: authData,
      error: authError,
    } =
      await supabaseAdmin.auth.admin.createUser({
        email:
          email.trim().toLowerCase(),

        password:
          temporaryPassword,

        email_confirm: true,
      });

    // =====================================================
    // AUTH USER CREATED
    // =====================================================

    if (authData?.user) {
      userId = authData.user.id;
    }

    // =====================================================
    // USER ALREADY EXISTS
    // =====================================================

    if (authError) {
      const msg =
        authError.message?.toLowerCase() || "";

      if (
        msg.includes("already") ||
        msg.includes("exists")
      ) {
        existingUser = true;

        // -----------------------------------------------
        // FIND EXISTING AUTH USER
        // -----------------------------------------------

        const {
          data,
          error,
        } =
          await supabaseAdmin.auth.admin.listUsers({
            page: 1,
            perPage: 1000,
          });

        if (error) {
          return res.status(400).json({
            error: error.message,
          });
        }

        const found =
          data.users.find(
            (u) =>
              u.email?.toLowerCase() ===
              email.trim().toLowerCase()
          );

        if (!found) {
          return res.status(400).json({
            error:
              "User exists but cannot be located",
          });
        }

        userId = found.id;

        // -----------------------------------------------
        // RESET TEMPORARY PASSWORD
        // -----------------------------------------------

        const {
          error: passwordError,
        } =
          await supabaseAdmin.auth.admin.updateUserById(
            userId,
            {
              password:
                temporaryPassword,
            }
          );

        if (passwordError) {
          return res.status(400).json({
            error:
              passwordError.message,
          });
        }

      } else {
        return res.status(400).json({
          error: authError.message,
        });
      }
    }

    // =====================================================
    // SAFETY CHECK
    // =====================================================

    if (!userId) {
      return res.status(400).json({
        error:
          "Unable to determine user ID.",
      });
    }

    // =====================================================
    // CHECK IF HUB USER PROFILE EXISTS
    // =====================================================

    const {
      data: existingProfile,
      error: profileCheckError,
    } =
      await supabaseAdmin
        .from("hub_users")
        .select("id")
        .eq(
          "auth_user_id",
          userId
        )
        .maybeSingle();

    if (profileCheckError) {
      return res.status(400).json({
        error:
          profileCheckError.message,
      });
    }

    // =====================================================
    // PROFILE DATA
    // =====================================================

    const profileData = {
      full_name:
        full_name.trim(),

      email:
        email.trim().toLowerCase(),

      role:
        role.trim(),

      institution_id,

      phone:
        phone?.trim() || null,

      employee_or_student_id:
        employee_or_student_id?.trim() || null,

      department_id:
        department_id || null,
         
        role_id:
      role_id || null,
      // -----------------------------------------------
      // STUDENT GROUP
      // -----------------------------------------------

      group_id:
        normalizedRole === "student"
          ? group_id || null
          : null,

      // -----------------------------------------------
      // STUDENT CLASS NAME
      //
      // This is the important addition.
      // -----------------------------------------------

      class_name:
        normalizedRole === "student"
          ? className
          : null,

      active: true,

      password_changed: false,
    };

    // =====================================================
    // UPDATE EXISTING HUB USER
    // =====================================================

    if (existingProfile) {
      console.log(
        "UPDATING EXISTING HUB USER:",
        existingProfile.id
      );

      const {
        error: updateError,
      } =
        await supabaseAdmin
          .from("hub_users")
          .update(profileData)
          .eq(
            "id",
            existingProfile.id
          );

      if (updateError) {
        return res.status(400).json({
          error:
            updateError.message,
        });
      }

    } else {

      // ===================================================
      // CREATE NEW HUB USER
      // ===================================================

      console.log(
        "CREATING NEW HUB USER"
      );

      const {
        error: insertError,
      } =
        await supabaseAdmin
          .from("hub_users")
          .insert({
            auth_user_id:
              userId,

            ...profileData,
          });

      if (insertError) {
        return res.status(400).json({
          error:
            insertError.message,
        });
      }
    }

    // =====================================================
    // RESPONSE
    // =====================================================

    console.log(
      "HUB360 USER CREATED:",
      {
        user_id: userId,
        email,
        role,
        group_id:
          normalizedRole === "student"
            ? group_id
            : null,
        class_name:
          normalizedRole === "student"
            ? className
            : null,
      }
    );

    return res.json({
      success: true,

      user_id:
        userId,

      email:
        email.trim().toLowerCase(),

      role:
        role.trim(),

      group_id:
        normalizedRole === "student"
          ? group_id || null
          : null,

      class_name:
        normalizedRole === "student"
          ? className
          : null,

      temporary_password:
        temporaryPassword,

      existing_user:
        existingUser,
    });

  } catch (err) {

    console.log(
      "CREATE HUB360 USER ERROR:",
      err
    );

    return res.status(500).json({
      error:
        err?.message ||
        "Internal server error",
    });
  }
});
/* ================= RESET HUB360 USER PASSWORD ================= */

app.post("/reset-hub360-password", async (req, res) => {
  try {
    const { auth_user_id } = req.body;

    if (!auth_user_id) {
      return res.status(400).json({
        success: false,
        error: "auth_user_id is required",
      });
    }

    console.log(
      "RESET HUB360 PASSWORD FOR:",
      auth_user_id
    );

    // Generate temporary password
    const temporaryPassword =
      "Hub@" +
      Math.floor(
        100000 + Math.random() * 900000
      );

    // =====================================================
    // UPDATE SUPABASE AUTH
    // IMPORTANT:
    // Use supabaseAdmin, NOT supabase
    // =====================================================

    const { data: updatedUser, error: authError } =
      await supabaseAdmin.auth.admin.updateUserById(
        auth_user_id,
        {
          password: temporaryPassword,
        }
      );

    if (authError) {
      console.log(
        "SUPABASE AUTH PASSWORD RESET ERROR:",
        authError
      );

      return res.status(400).json({
        success: false,
        error: authError.message,
      });
    }

    if (!updatedUser?.user) {
      return res.status(400).json({
        success: false,
        error: "Supabase did not return the updated user.",
      });
    }

    // =====================================================
    // FORCE PASSWORD CHANGE
    // =====================================================

    const { error: hubUserError } =
      await supabaseAdmin
        .from("hub_users")
        .update({
          must_change_password: true,
        })
        .eq(
          "auth_user_id",
          auth_user_id
        );

    if (hubUserError) {
      console.log(
        "HUB USER UPDATE ERROR:",
        hubUserError
      );

      return res.status(400).json({
        success: false,
        error:
          "Password was reset, but failed to set must_change_password: " +
          hubUserError.message,
      });
    }

    // =====================================================
    // SUCCESS
    // =====================================================

    console.log(
      "HUB360 PASSWORD RESET SUCCESS:",
      auth_user_id
    );

    return res.status(200).json({
      success: true,
      temporary_password:
        temporaryPassword,
    });

  } catch (err) {
    console.log(
      "RESET HUB360 PASSWORD SERVER ERROR:",
      err
    );

    return res.status(500).json({
      success: false,
      error:
        err?.message ||
        "Internal server error",
    });
  }
});
/* ================= REMOVE ADMIN ================= */
app.post("/remove-admin", async (req, res) => {
  try {
    const { userId, system } = req.body;

    if (!userId) {
      return res.status(400).json({ error: "userId required" });
    }
    // remove from correct table
    if (system === "nasara") {
      const { error } = await supabaseAdmin
        .from("admins")
        .delete()
        .eq("user_id", userId);

      if (error) return res.status(400).json({ error: error.message });
    }

    if (system === "coalition") {
      const { error } = await supabaseAdmin
        .from("coalition_admins")
        .delete()
        .eq("user_id", userId);

      if (error) return res.status(400).json({ error: error.message });
    }
    if (system === "utilities") {
  const { error } = await supabaseAdmin
    .from("utility_admins")
    .delete()
    .eq("user_id", userId);

  if (error) {
    return res.status(400).json({
      error: error.message,
    });
  }
}

    return res.json({
      success: true,
    });
  } catch (err) {
    return res.status(500).json({ error: "Server error" });
  }
});
/* ================= REMOVE CONSTITUENCY ADMIN ================= */
app.post("/remove-constituency-admin", async (req, res) => {
  try {
    const { userId } = req.body;

    if (!userId) {
      return res.status(400).json({ error: "userId required" });
    }

    // 1. remove from constituency_admins
    const { error: dbError } = await supabaseAdmin
      .from("constituency_admins")
      .delete()
      .eq("user_id", userId);

    if (dbError) {
      return res.status(400).json({ error: dbError.message });
    }

    // 2. delete auth user (important cleanup)
    const { error: authError } =
      await supabaseAdmin.auth.admin.deleteUser(userId);

    if (authError) {
      return res.status(400).json({ error: authError.message });
    }

    return res.json({
      success: true,
      message: "Constituency admin removed",
    });
  } catch (err) {
    return res.status(500).json({ error: "Server error" });
  }
});
/* ======================================================
   🟦 NASARA ACCOUNT DELETION
   🟢 STEP 1: Verify user
   🟣 STEP 2: Clean database
   🟠 STEP 3: Delete authentication account
   🔴 STEP 4: Log errors
   ====================================================== */

app.post("/delete-account", async (req, res) => {
  try {
    // 🔵 STEP 1: CHECK AUTHORIZATION

    const authorization = req.headers.authorization;

    if (!authorization?.startsWith("Bearer ")) {
      return res.status(401).json({
        error: "No valid authorization token provided",
      });
    }

    const token = authorization.slice(7).trim();

    if (!token) {
      return res.status(401).json({
        error: "No token provided",
      });
    }

    // 🟣 STEP 2: VERIFY THE USER

    const { data, error: userError } =
      await supabaseAdmin.auth.getUser(token);

    if (userError || !data?.user) {
      console.error("🔴 Authentication error:", {
        message: userError?.message,
        code: userError?.code,
      });

      return res.status(401).json({
        error: "Invalid or expired token",
      });
    }

    const userId = data.user.id;

    console.log("🟠 Account deletion started");

    // 🟣 STEP 3: RUN DATABASE CLEANUP

    const { error: rpcError } = await supabaseAdmin.rpc(
      "delete_user_everything",
      {
        uid: userId,
      }
    );

    if (rpcError) {
      console.error("🔴 Database deletion error:", {
        message: rpcError.message,
        code: rpcError.code,
        details: rpcError.details,
        hint: rpcError.hint,
      });

      return res.status(500).json({
        error: "Database error deleting user",
        details: rpcError.message,
        code: rpcError.code,
        hint: rpcError.hint,
      });
    }

    // 🟢 STEP 4: DELETE THE AUTH ACCOUNT LAST

    const { error: authError } =
      await supabaseAdmin.auth.admin.deleteUser(userId);

    if (authError) {
      console.error("🔴 Auth deletion error:", {
        message: authError.message,
        code: authError.code,
      });

      return res.status(500).json({
        error: "Database cleanup succeeded, but authentication deletion failed",
        details: authError.message,
        code: authError.code,
      });
    }

    // 🟢 STEP 5: CONFIRM SUCCESS

    console.log("🟢 Account deletion completed");

    return res.status(200).json({
      success: true,
      message: "Account deleted successfully",
    });

  } catch (err) {
    // 🔴 STEP 6: HANDLE UNEXPECTED ERRORS

    console.error("🔴 Unexpected deletion error:", {
      message: err?.message,
      stack: err?.stack,
    });

    return res.status(500).json({
      error: "Unexpected error deleting account",
    });
  }
});
/* ================= SEND PUSH ================= */

async function sendPush(
  tokens,
  title,
  body,
  data = {}
) {
  const messages =
    tokens.map((token) => ({
      to: token,

      sound: "default",

      title,

      body,

      data,

      priority: "high",

      channelId:
        "default",
    }));

  await fetch(
    "https://exp.host/--/api/v2/push/send",
    {
      method: "POST",

      headers: {
        "Content-Type":
          "application/json",
      },

      body: JSON.stringify(
        messages
      ),
    }
  );
}
/* ================= QUOTATION PDF ================= */
app.get("/quotation-pdf/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const { data } = await supabaseAdmin
      .from("utility_quotations")
      .select(", utility_applications()")
      .eq("id", id)
      .single();

    if (!data) {
      return res.status(404).json({ error: "Not found" });
    }

    const doc = new PDFDocument();
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename=quotation-${id}.pdf`
    );

    doc.pipe(res);

    doc.fontSize(16).text(
      "NATIONAL ELECTRICITY DISTRIBUTION COMPANY (NEDCo)",
      { align: "center" }
    );

    doc.moveDown();

    doc.fontSize(14).text(
      "QUOTATION FOR ELECTRICITY SUPPLY",
      { align: "center" }
    );

    doc.moveDown();

    doc.fontSize(12).text(`Reference ID: ${data.application_id}`);
    doc.text(`Applicant: ${data.utility_applications.full_name}`);
    doc.text(`Address: ${data.utility_applications.address}`);
    doc.text(`Amount: GH₵${data.amount}`);

    doc.moveDown();

    doc.text(data.letter_text || "");

    doc.moveDown(2);

    doc.text("__________");
    doc.text("NEDCo Utility Administrator");

    doc.end();
  } catch (err) {
    console.log(err);
    res.status(500).json({ error: "PDF generation failed" });
  }
});

/* ================= SEND BROWSER NOTIFICATION TO LOGGED-IN USER ================= */

app.post("/browser-push/send-me", async (req, res) => {
  try {
    const authorization = req.headers.authorization || "";

    if (!authorization.startsWith("Bearer ")) {
      return res.status(401).json({
        success: false,
        error: "Authentication is required.",
      });
    }

    const token = authorization.slice(7).trim();

    if (!token) {
      return res.status(401).json({
        success: false,
        error: "Invalid authentication token.",
      });
    }

    const { data: authData, error: authError } =
      await supabaseAdmin.auth.getUser(token);

    if (authError || !authData?.user) {
      return res.status(401).json({
        success: false,
        error: "Your session is invalid or has expired.",
      });
    }

    const { title, body, url } = req.body || {};

    if (
      typeof title !== "string" ||
      !title.trim() ||
      typeof body !== "string" ||
      !body.trim()
    ) {
      return res.status(400).json({
        success: false,
        error: "A notification title and body are required.",
      });
    }

    if (title.length > 120 || body.length > 1000) {
      return res.status(400).json({
        success: false,
        error: "The notification title or body is too long.",
      });
    }

    const notificationUrl =
      typeof url === "string" &&
      url.startsWith("/") &&
      !url.startsWith("//")
        ? url
        : "/";

    const result = await sendBrowserPushToUser(
      authData.user.id,
      title.trim(),
      body.trim(),
      notificationUrl
    );

    return res.json({
      success: result.success,
      sent: result.sent,
      failed: result.failed || 0,
      message:
        result.message || "Browser notification processed.",
    });
  } catch (error) {
    console.error("SEND BROWSER PUSH ERROR:", error);

    return res.status(500).json({
      success: false,
      error: "Could not send the browser notification.",
    });
  }
});

// =====================================================
// 🟢 NASARA — REGISTER / TRANSFER BROWSER PUSH SUBSCRIPTION
// Route: POST /browser-push/register-subscription
// File: index.js
// =====================================================

app.post("/browser-push/register-subscription", async (req, res) => {
try {
// 🔐 STEP 1: Read the authenticated user’s access token.
const authorization = req.headers.authorization || "";

if (!authorization.startsWith("Bearer ")) {
  return res.status(401).json({
    success: false,
    error: "Authentication is required.",
  });
}
const token = authorization.slice(7).trim();
if (!token) {
  return res.status(401).json({
    success: false,
    error: "Invalid authentication token.",
  });
}
// 🔐 STEP 2: Verify the token with Supabase.
// Never trust a user_id supplied by the browser.
const {
  data: authData,
  error: authError,
} = await supabaseAdmin.auth.getUser(token);
if (authError || !authData?.user) {
  return res.status(401).json({
    success: false,
    error: "Your session is invalid or has expired.",
  });
}
const authenticatedUserId = authData.user.id;
// 📦 STEP 3: Read the browser subscription.
const { subscription } = req.body || {};
if (
  !subscription ||
  typeof subscription !== "object" ||
  typeof subscription.endpoint !== "string" ||
  !subscription.endpoint.startsWith("https://") ||
  !subscription.keys ||
  typeof subscription.keys.p256dh !== "string" ||
  !subscription.keys.p256dh.trim() ||
  typeof subscription.keys.auth !== "string" ||
  !subscription.keys.auth.trim()
) {
  return res.status(400).json({
    success: false,
    error: "A valid browser push subscription is required.",
  });
}
// 🕒 STEP 4: Save the subscription for the authenticated account.
//
// If this browser endpoint already belongs to another Nasara
// account, the existing row is reassigned to the current account.
//
// The unique endpoint constraint prevents duplicate endpoint rows.
// The service-role client is used only on the trusted backend.
const { data: savedSubscription, error: saveError } =
  await supabaseAdmin
    .from("browser_push_subscriptions")
    .upsert(
      {
        user_id: authenticatedUserId,
        endpoint: subscription.endpoint,
        subscription,
        updated_at: new Date().toISOString(),
      },
      {
        onConflict: "endpoint",
      }
    )
    .select("id")
    .single();
if (saveError) {
  console.error(
    "REGISTER BROWSER PUSH SUBSCRIPTION ERROR:",
    saveError
  );
  return res.status(500).json({
    success: false,
    error: "Could not save the browser notification subscription.",
  });
}
// ✅ STEP 5: Return success.
return res.json({
  success: true,
  message: "Browser notification subscription registered successfully.",
  subscriptionId: savedSubscription?.id ?? null,
});

} catch (error) {
console.error(
"REGISTER BROWSER PUSH SUBSCRIPTION ERROR:",
error
);

return res.status(500).json({
  success: false,
  error: "An unexpected error occurred while registering notifications.",
});

}
});
/* ================= BROADCAST BROWSER NOTIFICATION TO ALL USERS ================= */

app.post("/browser-push/broadcast", async (req, res) => {
  try {
    const authorization = req.headers.authorization || "";

    if (!authorization.startsWith("Bearer ")) {
      return res.status(401).json({
        success: false,
        error: "Authentication is required.",
      });
    }

    const token = authorization.slice(7).trim();

    if (!token) {
      return res.status(401).json({
        success: false,
        error: "Invalid authentication token.",
      });
    }

    const { data: authData, error: authError } =
      await supabaseAdmin.auth.getUser(token);

    if (authError || !authData?.user) {
      return res.status(401).json({
        success: false,
        error: "Your session is invalid or has expired.",
      });
    }

    /* ================= VERIFY NASARA ADMIN ================= */

    const { data: admin, error: adminError } =
      await supabaseAdmin
        .from("admins")
        .select("user_id")
        .eq("user_id", authData.user.id)
        .maybeSingle();

    if (adminError) {
      console.error("BROWSER PUSH ADMIN CHECK ERROR:", adminError);

      return res.status(500).json({
        success: false,
        error: "Could not verify administrator permissions.",
      });
    }

    if (!admin) {
      return res.status(403).json({
        success: false,
        error: "Only authorized Nasara administrators can broadcast notifications.",
      });
    }

    /* ================= VALIDATE NOTIFICATION ================= */

    const { title, body, url } = req.body || {};

    if (
      typeof title !== "string" ||
      !title.trim() ||
      typeof body !== "string" ||
      !body.trim()
    ) {
      return res.status(400).json({
        success: false,
        error: "A notification title and body are required.",
      });
    }

    if (title.length > 120 || body.length > 1000) {
      return res.status(400).json({
        success: false,
        error: "The notification title or body is too long.",
      });
    }

    const notificationUrl =
      typeof url === "string" &&
      url.startsWith("/") &&
      !url.startsWith("//")
        ? url
        : "/";

    /* ================= SEND BROADCAST ================= */

    const result = await broadcastBrowserPush(
      title.trim(),
      body.trim(),
      notificationUrl
    );

    return res.json({
      success: result.success,
      sent: result.sent,
      failed: result.failed,
      message: "Browser notification broadcast processed.",
    });
  } catch (error) {
    console.error("BROWSER PUSH BROADCAST ERROR:", error);

    return res.status(500).json({
      success: false,
      error: "Could not broadcast browser notifications.",
    });
  }
});

/* ================= SECURE ITEM PUSH NOTIFICATIONS ================= */

app.post("/send-push", async (req, res) => {
  try {
    // =====================================================
    // 1. VERIFY AUTHENTICATION
    // =====================================================

    const authorization = req.headers.authorization || "";

    if (!authorization.startsWith("Bearer ")) {
      return res.status(401).json({
        success: false,
        error: "Authentication is required.",
      });
    }

    const token = authorization.slice(7).trim();

    if (!token) {
      return res.status(401).json({
        success: false,
        error: "Invalid authentication token.",
      });
    }

    const {
      data: authData,
      error: authError,
    } = await supabaseAdmin.auth.getUser(token);

    if (authError || !authData?.user) {
      return res.status(401).json({
        success: false,
        error: "Your session is invalid or has expired.",
      });
    }

    const userId = authData.user.id;

    // =====================================================
    // 2. VALIDATE THE REQUEST
    // =====================================================

    const { title, body, type, ref_id } = req.body || {};

    if (
      typeof title !== "string" ||
      !title.trim() ||
      typeof body !== "string" ||
      !body.trim()
    ) {
      return res.status(400).json({
        success: false,
        error: "A notification title and body are required.",
      });
    }

    if (title.length > 120 || body.length > 1000) {
      return res.status(400).json({
        success: false,
        error: "The notification title or body is too long.",
      });
    }

    // =====================================================
    // 3. ACCEPT ONLY ITEM NOTIFICATIONS
    // =====================================================

    if (type !== "item" || !ref_id) {
      return res.status(400).json({
        success: false,
        error: "Invalid item notification request.",
      });
    }

    // =====================================================
    // 4. VERIFY ITEM OWNERSHIP
    // =====================================================

    const {
      data: item,
      error: itemError,
    } = await supabaseAdmin
      .from("items_live")
      .select("id, user_id, title")
      .eq("id", ref_id)
      .maybeSingle();

    if (itemError) {
      console.error(
        "ITEM OWNERSHIP CHECK ERROR:",
        itemError
      );

      return res.status(500).json({
        success: false,
        error: "Could not verify the item.",
      });
    }

    if (!item || item.user_id !== userId) {
      return res.status(403).json({
        success: false,
        error:
          "You are not authorized to notify users about this item.",
      });
    }

    // =====================================================
// 🟢 4B. GET SELLER NAME AND BUILD NOTIFICATION
// =====================================================

// 👤 RETRIEVE SELLER PROFILE
const {
data: sellerProfile,
error: sellerProfileError,
} = await supabaseAdmin
.from("profiles")
.select("full_name")
.eq("id", item.user_id)
.maybeSingle();

// 🔴 LOG PROFILE LOOKUP ERRORS
if (sellerProfileError) {
console.error(
"SELLER PROFILE LOOKUP ERROR:",
sellerProfileError.message
);
}

// 🟢 USE THE SELLER’S ACTUAL NAME
const sellerName =
sellerProfile?.full_name?.trim() || "A Nasara User";

// 🛒 BUILD NOTIFICATION TITLE
const notificationTitle =
`🛒 New Item from ${sellerName}`;

// 📦 USE THE VERIFIED ITEM TITLE AS THE MESSAGE
const notificationBody =
typeof item.title === "string" && item.title.trim()
? item.title.trim().slice(0, 1000)
: body.trim();

    // =====================================================
    // 5. SEND EXISTING EXPO / NATIVE PUSH NOTIFICATIONS
    // =====================================================

    const {
      data: users,
      error: usersError,
    } = await supabaseAdmin
      .from("profiles")
      .select("push_token")
      .neq("id", userId);

    if (usersError) {
      console.error(
        "EXPO PUSH TOKEN LOOKUP ERROR:",
        usersError.message
      );

      return res.status(500).json({
        success: false,
        error: "Could not retrieve notification recipients.",
      });
    }

    const tokens = (users || [])
      .map((user) => user.push_token)
      .filter(Boolean);

    if (tokens.length > 0) {
      await sendPush(
        tokens,
        notificationTitle,
        notificationBody,
        {
          type: "item",
          ref_id: item.id,
        }
      );
    }

    // =====================================================
    // 6. SEND BROWSER PUSH NOTIFICATIONS
    // =====================================================

    const itemUrl = `/item/${encodeURIComponent(item.id)}`;

    const browserResult = await broadcastBrowserPush(
      notificationTitle,
      notificationBody,
      itemUrl,
      userId
    );

    console.log("ITEM PUSH RESULT:", {
      itemId: item.id,
      nativeRecipients: tokens.length,
      browserResult,
    });

    // =====================================================
    // 7. RETURN RESULT
    // =====================================================

    return res.json({
      success: true,
      nativeRecipients: tokens.length,
      browser: browserResult,
      message: "Item notifications processed.",
    });
  } catch (error) {
    console.error("SECURE ITEM PUSH ERROR:", error);

    return res.status(500).json({
      success: false,
      error: "Could not process item notifications.",
    });
  }
});

/* 🟣 =====================================================
🎥 NASARA REEL WEBSITE BROWSER PUSH NOTIFICATIONS
📁 File: index.js
📍 Location: Immediately after the existing /send-push route
===================================================== */

/* 🟢 1. SECURE REEL BROWSER NOTIFICATION ENDPOINT */

app.post("/reel-browser-push", async (req, res) => {
  try {

    /* 🔐 2. VERIFY USER AUTHENTICATION */

    const authorization = req.headers.authorization || "";

    if (!authorization.startsWith("Bearer ")) {
      return res.status(401).json({
        success: false,
        error: "Authentication is required.",
      });
    }

    const token = authorization.slice(7).trim();

    if (!token) {
      return res.status(401).json({
        success: false,
        error: "Invalid authentication token.",
      });
    }

    const {
      data: authData,
      error: authError,
    } = await supabaseAdmin.auth.getUser(token);

    if (authError || !authData?.user) {
      return res.status(401).json({
        success: false,
        error: "Your session is invalid or has expired.",
      });
    }

    const userId = authData.user.id;


    /* 🔵 3. VALIDATE THE REEL ID */

    const { ref_id } = req.body || {};

    if (
      typeof ref_id !== "string" ||
      !ref_id.trim() ||
      ref_id.length > 200
    ) {
      return res.status(400).json({
        success: false,
        error: "A valid Reel ID is required.",
      });
    }


    /* 🟣 4. VERIFY THAT THE REEL BELONGS TO THE USER */

    const {
      data: reel,
      error: reelError,
    } = await supabaseAdmin
      .from("posts")
      .select("id, user_id, caption, status")
      .eq("id", ref_id)
      .maybeSingle();

    if (reelError) {
      console.error(
        "🎥 REEL LOOKUP ERROR:",
        reelError
      );

      return res.status(500).json({
        success: false,
        error: "Could not verify the Reel.",
      });
    }

    if (!reel || reel.user_id !== userId) {
      return res.status(403).json({
        success: false,
        error:
          "You are not authorized to notify users about this Reel.",
      });
    }


    /* 🟠 5. ENSURE THE REEL IS READY */

    if (reel.status !== "ready") {
      return res.status(400).json({
        success: false,
        error: "This Reel is not ready to be published.",
      });
    }


    /* 🟡 6. GET THE CREATOR'S PROFILE NAME */

    const {
      data: creatorProfile,
      error: profileError,
    } = await supabaseAdmin
      .from("profiles")
      .select("full_name")
      .eq("id", reel.user_id)
      .maybeSingle();

    if (profileError) {
      console.error(
        "🎥 REEL CREATOR PROFILE ERROR:",
        profileError
      );
    }

    const creatorName =
      creatorProfile?.full_name?.trim() ||
      "A Nasara user";


    /* 🟢 7. PREPARE THE PERSONALIZED NOTIFICATION */

    const notificationTitle =
      `🎥 New Reel from ${creatorName}`;

    const notificationBody =
      typeof reel.caption === "string" &&
      reel.caption.trim()
        ? reel.caption.trim().slice(0, 200)
        : `${creatorName} has posted a new Reel on Nasara.`;


    /* 🔵 8. SEND WEBSITE BROWSER PUSH NOTIFICATIONS */
    // Notify subscribed browser users.
    // Exclude the person who posted the Reel.
    // Do not send native app notifications here.

    const browserResult = await broadcastBrowserPush(
      notificationTitle,
      notificationBody,
      "/reels",
      userId
    );

    /* 🟣 9. LOG THE RESULT */

    console.log("🎥 REEL BROWSER PUSH RESULT:", {
      reelId: reel.id,
      creatorName,
      notificationTitle,
      browserResult,
    });


    /* 🟢 10. RETURN THE RESULT */

    return res.json({
      success: true,
      creator: creatorName,
      browser: browserResult,
      message:
        "Personalized Reel browser notifications processed.",
    });

  } catch (error) {

    /* 🔴 11. HANDLE ERRORS */

    console.error(
      "🎥 REEL BROWSER PUSH ERROR:",
      error
    );

    return res.status(500).json({
      success: false,
      error:
        "Could not process Reel browser notifications.",
    });

  }
});

/* 🟣 =====================================================
💬 NASARA CHAT WEBSITE BROWSER PUSH NOTIFICATIONS
📁 FILE: index.js
📍 ADD AFTER THE /reel-browser-push ROUTE
===================================================== */

app.post("/chat-browser-push", async (req, res) => {
  /* 🟣 DIAGNOSTIC: CONFIRM THE CHAT ROUTE IS REACHED */
console.log("💬 CHAT BROWSER PUSH ROUTE HIT:", {
  method: req.method,
  path: req.originalUrl,
  hasAuthorization: Boolean(req.headers.authorization),
  body: req.body,
});
try {
/* 🔵 1. VERIFY THE SENDER’S AUTHENTICATION */

const authorization = req.headers.authorization || "";
if (!authorization.startsWith("Bearer ")) {
  return res.status(401).json({
    success: false,
    error: "Authentication is required.",
  });
}
const token = authorization.slice(7).trim();
if (!token) {
  return res.status(401).json({
    success: false,
    error: "Invalid authentication token.",
  });
}
const {
  data: authData,
  error: authError,
} = await supabaseAdmin.auth.getUser(token);
if (authError || !authData?.user) {
  return res.status(401).json({
    success: false,
    error: "Your session is invalid or has expired.",
  });
}
const senderId = authData.user.id;
/* 🟣 2. VALIDATE THE REQUEST */
const { message_id, recipient_id } = req.body || {};
/* 🟣 VALIDATE MESSAGE AND RECIPIENT IDs */

if (
  !(
    typeof message_id === "string" ||
    (typeof message_id === "number" &&
      Number.isFinite(message_id))
  ) ||
  String(message_id).trim() === "" ||
  typeof recipient_id !== "string" ||
  !recipient_id.trim()
) {
  return res.status(400).json({
    success: false,
    error: "A valid message ID and recipient ID are required.",
  });
}
if (senderId === recipient_id) {
  return res.status(400).json({
    success: false,
    error: "You cannot send a chat notification to yourself.",
  });
}
/* 🟠 3. VERIFY THAT THE MESSAGE EXISTS AND BELONGS TO THE SENDER */
const {
  data: message,
  error: messageError,
} = await supabaseAdmin
  .from("messages")
  .select(
    "id, sender_id, room_id, text, image_url, audio_url, file_url, file_name"
  )
  .eq("id", message_id)
  .maybeSingle();
if (messageError) {
  console.error("🔴 CHAT MESSAGE LOOKUP ERROR:", messageError);
  return res.status(500).json({
    success: false,
    error: "Could not verify the chat message.",
  });
}
if (!message || message.sender_id !== senderId) {
  return res.status(403).json({
    success: false,
    error: "You are not authorized to notify users about this message.",
  });
}
if (!message.room_id) {
  return res.status(400).json({
    success: false,
    error: "The message does not have a valid chat room.",
  });
}
/* 🟡 4. VERIFY THE SENDER AND RECIPIENT BELONG TO THE SAME CHAT ROOM */

// 🟢 Load the actual chat room participants from chat_rooms
const {
  data: room,
  error: roomError,
} = await supabaseAdmin
  .from("chat_rooms")
  .select("id, buyer_id, seller_id")
  .eq("id", message.room_id)
  .maybeSingle();

// 🔴 Handle room lookup errors
if (roomError) {
  console.error("🔴 CHAT ROOM LOOKUP ERROR:", roomError);

  return res.status(500).json({
    success: false,
    error: "Could not verify the chat room.",
  });
}

// 🔴 Ensure the room exists
if (!room) {
  return res.status(403).json({
    success: false,
    error: "The chat room could not be verified.",
  });
}

// 🟢 Confirm that the authenticated sender belongs to this room
const senderBelongsToRoom =
  room.buyer_id === senderId ||
  room.seller_id === senderId;

// 🟢 Confirm that the intended recipient is the other participant
const recipientBelongsToRoom =
  (room.buyer_id === senderId &&
    room.seller_id === recipient_id) ||
  (room.seller_id === senderId &&
    room.buyer_id === recipient_id);

// 🔴 Reject requests that do not match the room's buyer and seller
if (!senderBelongsToRoom || !recipientBelongsToRoom) {
  console.error("🔴 CHAT ROOM PARTICIPANT VALIDATION FAILED:", {
    roomId: message.room_id,
    senderId,
    recipientId: recipient_id,
    buyerId: room.buyer_id,
    sellerId: room.seller_id,
  });

  return res.status(403).json({
    success: false,
    error: "The sender and recipient must belong to the same chat room.",
  });
}

console.log("🟢 CHAT ROOM PARTICIPANTS VERIFIED:", {
  roomId: room.id,
  senderId,
  recipientId: recipient_id,
});
// 🟣 =====================================================
// 🟣 5. GET SENDER NAME AND PROFILE IMAGE
// 🟣 =====================================================

const {
  data: chatSender,
  error: chatSenderError,
} = await supabaseAdmin
  .from("profiles")
  .select("full_name, avatar_url")
  .eq("id", message.sender_id)
  .maybeSingle();

if (chatSenderError) {
  console.error(
    "🔴 CHAT SENDER PROFILE LOOKUP ERROR:",
    chatSenderError.message
  );
}

const senderName =
  chatSender?.full_name?.trim() || "A Nasara User";

const senderAvatar =
  chatSender?.avatar_url || null;

console.log("🟢 CHAT SENDER AVATAR:", senderAvatar);

const notificationTitle = `💬 ${senderName}`;

const notificationBody =
  typeof message.text === "string" && message.text.trim()
    ? message.text.trim().slice(0, 160)
    : message.image_url
    ? "🖼️ Sent you a photo"
    : message.audio_url
    ? "🎤 Sent you a voice note"
    : message.file_url
    ? `📎 Sent you a file${
        message.file_name ? `: ${message.file_name}` : ""
      }`
    : "📩 Sent you a new message";

// 🟢 =====================================================
// 🟢 6. SEND CHAT NOTIFICATION WITH PROFILE IMAGE
// 🟢 =====================================================

const browserResult = await sendBrowserPushToUser(
  recipient_id,
  notificationTitle,
  notificationBody,
  `/chat/${message.room_id}`,
  {
    icon: senderAvatar,
    image: senderAvatar,
    tag: `nasara-chat-${message.room_id}`,
    room_id: message.room_id,
  }
);

// 🟢 SEND EXPO PUSH TO ANDROID RECIPIENTS
let expoResult = null;

try {
  expoResult = await notifyUser(
    recipient_id,
    notificationTitle,
    notificationBody
  );

  console.log("🟢 CHAT EXPO PUSH RESULT:", expoResult);
} catch (expoError) {
  console.error("🔴 CHAT EXPO PUSH ERROR:", expoError);
}
/* 🟢 7. LOG THE RESULT */
console.log("💬 CHAT BROWSER PUSH RESULT:", {
  messageId: message.id,
  recipientId: recipient_id,
  browserResult,
});
/* 🟢 8. RETURN SUCCESS */
return res.json({
  success: true,
  browser: browserResult,
  expo: expoResult,
  message: "Chat notifications processed.",
});

} catch (error) {
/* 🔴 9. HANDLE UNEXPECTED ERRORS */

console.error("💬 CHAT BROWSER PUSH ERROR:", error);
return res.status(500).json({
  success: false,
  error: "Could not process the chat browser notification.",
});

}
});

/* 🟣 =====================================================
💬 NASARA GROUP CHAT BROWSER PUSH NOTIFICATIONS
🟣 Sender Profile Image • Message Preview • Group Navigation
===================================================== */

app.post("/group-browser-push", async (req, res) => {
  console.log("💬 GROUP BROWSER PUSH ROUTE HIT:", {
    hasAuthorization: Boolean(req.headers.authorization),
    body: req.body,
  });

  try {
    // 🔵 1. VERIFY AUTHENTICATION

    const authorization = req.headers.authorization || "";

    if (!authorization.startsWith("Bearer ")) {
      return res.status(401).json({
        success: false,
        error: "Authentication is required.",
      });
    }

    const token = authorization.slice(7).trim();

    if (!token) {
      return res.status(401).json({
        success: false,
        error: "Invalid authentication token.",
      });
    }

    const {
      data: authData,
      error: authError,
    } = await supabaseAdmin.auth.getUser(token);

    if (authError || !authData?.user) {
      return res.status(401).json({
        success: false,
        error: "Your session is invalid or has expired.",
      });
    }

    const senderId = authData.user.id;

    // 🟣 2. VALIDATE MESSAGE ID

    const { message_id } = req.body || {};

    if (
      !(
        typeof message_id === "string" ||
        (typeof message_id === "number" &&
          Number.isFinite(message_id))
      ) ||
      String(message_id).trim() === ""
    ) {
      return res.status(400).json({
        success: false,
        error: "A valid group message ID is required.",
      });
    }

    // 🔵 3. VERIFY THE GROUP MESSAGE

    const {
      data: message,
      error: messageError,
    } = await supabaseAdmin
      .from("group_messages")
      .select(
        "id, group_id, sender_id, text, image_url, audio_url, file_url, file_name"
      )
      .eq("id", message_id)
      .maybeSingle();

    if (messageError) {
      console.error("🔴 GROUP MESSAGE LOOKUP ERROR:", messageError);

      return res.status(500).json({
        success: false,
        error: "Could not verify the group message.",
      });
    }

    if (!message || message.sender_id !== senderId) {
      return res.status(403).json({
        success: false,
        error: "You are not authorized to notify users about this message.",
      });
    }

    if (!message.group_id) {
      return res.status(400).json({
        success: false,
        error: "The message does not have a valid group.",
      });
    }

    // 🟣 4. VERIFY THE SENDER IS A GROUP MEMBER

    const {
      data: senderMembership,
      error: senderMembershipError,
    } = await supabaseAdmin
      .from("group_members")
      .select("user_id")
      .eq("group_id", message.group_id)
      .eq("user_id", senderId)
      .maybeSingle();

    if (senderMembershipError) {
      console.error(
        "🔴 GROUP SENDER MEMBERSHIP ERROR:",
        senderMembershipError
      );

      return res.status(500).json({
        success: false,
        error: "Could not verify group membership.",
      });
    }

    if (!senderMembership) {
      return res.status(403).json({
        success: false,
        error: "You are not a member of this group.",
      });
    }

    // 🟢 5. GET OTHER GROUP MEMBERS

    const {
      data: members,
      error: membersError,
    } = await supabaseAdmin
      .from("group_members")
      .select("user_id")
      .eq("group_id", message.group_id)
      .neq("user_id", senderId);

    if (membersError) {
      console.error("🔴 GROUP MEMBERS LOOKUP ERROR:", membersError);

      return res.status(500).json({
        success: false,
        error: "Could not load group members.",
      });
    }

    const recipientIds = [
      ...new Set(
        (members || [])
          .map((member) => member.user_id)
          .filter((userId) => userId && userId !== senderId)
      ),
    ];

    if (recipientIds.length === 0) {
      return res.json({
        success: true,
        sent: 0,
        failed: 0,
        message: "There are no other group members to notify.",
      });
    }

    // 🟣 6. GET SENDER PROFILE

    const {
      data: senderProfile,
      error: profileError,
    } = await supabaseAdmin
      .from("profiles")
      .select("full_name, avatar_url")
      .eq("id", senderId)
      .maybeSingle();

    if (profileError) {
      console.error(
        "🔴 GROUP SENDER PROFILE ERROR:",
        profileError.message
      );
    }

    const senderName =
      senderProfile?.full_name?.trim() || "A Nasara User";

    const senderAvatar = senderProfile?.avatar_url || null;

    // 🟡 7. PREPARE MESSAGE PREVIEW

    const notificationTitle = `👥 ${senderName}`;

    const notificationBody =
      typeof message.text === "string" && message.text.trim()
        ? message.text.trim().slice(0, 160)
        : message.image_url
        ? "🖼️ Shared a photo in the group"
        : message.audio_url
        ? "🎤 Sent a voice note in the group"
        : message.file_url
        ? `📎 Shared a file${
            message.file_name ? `: ${message.file_name}` : ""
          }`
        : "📩 Sent a new group message";

    // 🟢 8. SEND TO EVERY OTHER GROUP MEMBER

    const notificationResults = await Promise.allSettled(
      recipientIds.map((recipientId) =>
        sendBrowserPushToUser(
          recipientId,
          notificationTitle,
          notificationBody,
          `/groups/${message.group_id}`,
          {
            icon: senderAvatar,
            image: senderAvatar,
            tag: `nasara-group-${message.group_id}`,
            room_id: message.group_id,
          }
        )
      )
    );
    // 🟢 =====================================================
// 🟢 SEND EXPO PUSH TO ANDROID GROUP MEMBERS
// 🟢 =====================================================

const expoResults = await Promise.allSettled(
  recipientIds.map(async (recipientId) => {
    return await notifyUser(
      recipientId,
      notificationTitle,
      notificationBody
    );
  })
);

let expoSent = 0;
let expoFailed = 0;

for (const result of expoResults) {
  if (result.status === "fulfilled") {
    expoSent++;
  } else {
    expoFailed++;

    console.error(
      "🔴 GROUP EXPO PUSH ERROR:",
      result.reason
    );
  }
}

console.log("🟢 GROUP EXPO PUSH SUMMARY:", {
  recipients: recipientIds.length,
  expoSent,
  expoFailed,
});

    let sent = 0;
    let failed = 0;

    for (const result of notificationResults) {
      if (result.status === "fulfilled") {
        sent += result.value.sent || 0;
      } else {
        failed++;

        console.error(
          "🔴 GROUP MEMBER NOTIFICATION ERROR:",
          result.reason
        );
      }
    }
    

    // 🔵 9. RETURN RESULTS

    console.log("🟢 GROUP BROWSER PUSH RESULT:", {
      messageId: message.id,
      groupId: message.group_id,
      recipients: recipientIds.length,
      sent,
      failed,
    });

    return res.json({
  success: true,
  sent,
  failed,
  expoSent,
  expoFailed,
  recipients: recipientIds.length,
  message: "Group browser and Expo notifications processed.",
});

  } catch (error) {
    console.error("🔴 GROUP BROWSER PUSH ERROR:", error);

    return res.status(500).json({
      success: false,
      error: "Could not process the group browser notification.",
    });
  }
});

// ============================================================
// 🟢 RESTAURANT NOTIFICATIONS — NEW ORDER
// Notifies the restaurant owner when a customer places an order.
// ============================================================

app.post("/restaurant/notify-new-order", async (req, res) => {
  try {
    // 🟢 1. Verify the authenticated customer
    const authorization = req.headers.authorization;

    if (!authorization || !authorization.startsWith("Bearer ")) {
      return res.status(401).json({
        success: false,
        message: "Authentication required.",
      });
    }

    const accessToken = authorization.substring(7);

    const {
      data: { user },
      error: authError,
    } = await supabaseAdmin.auth.getUser(accessToken);

    if (authError || !user) {
      return res.status(401).json({
        success: false,
        message: "Invalid authentication.",
      });
    }

    // 🟢 2. Validate the order ID
    const { orderId } = req.body;

    if (!orderId) {
      return res.status(400).json({
        success: false,
        message: "Order ID is required.",
      });
    }

    // 🟢 3. Retrieve the order
    const { data: order, error: orderError } = await supabaseAdmin
      .from("food_orders")
      .select(
        "id, order_number, customer_id, restaurant_id, total_amount, order_status"
      )
      .eq("id", orderId)
      .maybeSingle();

    if (orderError) {
      console.error("Restaurant notification order lookup failed:", orderError);

      return res.status(500).json({
        success: false,
        message: "Could not verify the order.",
      });
    }

    if (!order) {
      return res.status(404).json({
        success: false,
        message: "Order not found.",
      });
    }

    // 🟢 4. Only the customer who created the order can trigger this.
    if (order.customer_id !== user.id) {
      return res.status(403).json({
        success: false,
        message: "You cannot trigger a notification for this order.",
      });
    }

    // 🟢 5. Find the restaurant and its owner
const { data: restaurant, error: restaurantError } = await supabaseAdmin
.from("restaurants")
.select("id, name, owner_id")
.eq("id", order.restaurant_id)
.maybeSingle();

if (restaurantError) {
  console.error("❌ Restaurant lookup error:", restaurantError);
  return res.status(500).json({
    success: false,
    message: "Could not find the restaurant."
  });
}
if (!restaurant) {
  return res.status(404).json({
    success: false,
    message: "Restaurant not found."
  });
}
// 🟢 6. Look up the restaurant owner using restaurant_owners first
const { data: ownerLink, error: ownerLinkError } = await supabaseAdmin
  .from("restaurant_owners")
  .select("id, user_id, restaurant_id, status")
  .eq("restaurant_id", restaurant.id)
  .maybeSingle();
if (ownerLinkError) {
  console.error("❌ Restaurant owner link lookup error:", ownerLinkError);
}
// 🟢 7. Use the linked owner first, then fall back to restaurants.owner_id
const restaurantOwnerId =
  ownerLink?.user_id || restaurant.owner_id;
if (!restaurantOwnerId) {
  console.error(
    "❌ No owner found for restaurant:",
    restaurant.id
  );
  return res.status(404).json({
    success: false,
    message: "Restaurant owner not found."
  });
}

    // 🟢 8. Prepare the notification
const title = "🍽️ New Restaurant Order";
const body = `Order ${order.order_number || order.id} has been placed at ${restaurant.name || "your restaurant"}.`;

// 🟢 9. Send the browser push notification
let browserResult = null;
try {
  browserResult = await sendBrowserPushToUser(
    restaurantOwnerId,
    title,
    body,
    "/orders"
  );
} catch (browserError) {
  console.error(
    "Restaurant browser push failed:",
    browserError.message
  );
}
// 🟢 10. Retrieve the owner's Expo push token
const { data: ownerProfile, error: profileError } =
  await supabaseAdmin
    .from("profiles")
    .select("push_token")
    .eq("id", restaurantOwnerId)
    .maybeSingle();
if (profileError) {
  console.error(
    "Restaurant owner push-token lookup failed:",
    profileError
  );
}
// 🟢 11. Send a mobile push notification when a token exists
let mobileSent = false;
if (ownerProfile?.push_token) {
  try {
    await sendPush(
      [ownerProfile.push_token],
      title,
      body,
      {
        type: "restaurant_order",
        order_id: order.id,
        restaurant_id: restaurant.id,
      }
    );
    mobileSent = true;
  } catch (mobileError) {
    console.error(
      "Restaurant mobile push failed:",
      mobileError.message
    );
  }
}
// 🟢 12. Return the result
return res.json({
  success: true,
  message: "Restaurant order notification processed.",
  browser: browserResult,
  mobileSent,
});

} catch (error) {
console.error(
"Restaurant new-order notification error:",
error
);

return res.status(500).json({
  success: false,
  message: "Restaurant notification failed.",
});

}
});


// ============================================================
// 🟢 RESTAURANT NOTIFICATIONS — ORDER COMPLETED
// Notifies the customer when their restaurant order is completed.
// ============================================================

app.post("/restaurant/notify-order-completed", async (req, res) => {
try {
// 🟢 1. Authenticate the restaurant owner
const authorization = req.headers.authorization;

if (!authorization || !authorization.startsWith("Bearer ")) {
  return res.status(401).json({
    success: false,
    message: "Authentication required.",
  });
}
const accessToken = authorization.substring(7);
const {
  data: { user },
  error: authError,
} = await supabaseAdmin.auth.getUser(accessToken);
if (authError || !user) {
  return res.status(401).json({
    success: false,
    message: "Invalid authentication.",
  });
}
// 🟢 2. Validate the order ID
const { orderId } = req.body || {};
if (!orderId) {
  return res.status(400).json({
    success: false,
    message: "Order ID is required.",
  });
}
// 🟢 3. Retrieve the order
const { data: order, error: orderError } = await supabaseAdmin
  .from("food_orders")
  .select(
    "id, order_number, customer_id, restaurant_id, order_status"
  )
  .eq("id", orderId)
  .maybeSingle();
if (orderError) {
  console.error(
    "Completed-order lookup failed:",
    orderError
  );
  return res.status(500).json({
    success: false,
    message: "Could not verify the order.",
  });
}
if (!order) {
  return res.status(404).json({
    success: false,
    message: "Order not found.",
  });
}
// 🟢 4. Confirm the order is actually completed
if (String(order.order_status).toLowerCase() !== "completed") {
  return res.status(409).json({
    success: false,
    message: "The order has not been completed.",
  });
}
// 🟢 5. Find the restaurant
const { data: restaurant, error: restaurantError } =
  await supabaseAdmin
    .from("restaurants")
    .select("id, name, owner_id")
    .eq("id", order.restaurant_id)
    .maybeSingle();
if (restaurantError) {
  console.error(
    "Completed-order restaurant lookup failed:",
    restaurantError
  );
  return res.status(500).json({
    success: false,
    message: "Could not verify the restaurant.",
  });
}
if (!restaurant) {
  return res.status(404).json({
    success: false,
    message: "Restaurant not found.",
  });
}
// 🟢 6. Verify the authenticated user manages this restaurant
const { data: ownerLink, error: ownerLinkError } =
  await supabaseAdmin
    .from("restaurant_owners")
    .select("user_id, restaurant_id, status")
    .eq("restaurant_id", restaurant.id)
    .eq("user_id", user.id)
    .maybeSingle();
if (ownerLinkError) {
  console.error(
    "Restaurant owner verification failed:",
    ownerLinkError
  );
  return res.status(500).json({
    success: false,
    message: "Could not verify restaurant ownership.",
  });
}
const isLinkedOwner =
  !!ownerLink &&
  (
    !ownerLink.status ||
    String(ownerLink.status).toLowerCase() === "active"
  );
const isFallbackOwner = restaurant.owner_id === user.id;
if (!isLinkedOwner && !isFallbackOwner) {
  return res.status(403).json({
    success: false,
    message: "You are not authorized to notify this customer.",
  });
}
// 🟢 7. Validate the customer ID
if (!order.customer_id) {
  return res.status(400).json({
    success: false,
    message: "The order has no associated customer.",
  });
}
// 🟢 8. Prepare the customer notification
const title = "🎉 Your Food Order Is Completed!";
const body =
  `Your order ${order.order_number || order.id} from ` +
  `${restaurant.name || "the restaurant"} has been completed. Thank you for ordering with Nasara!`;
// 🟢 9. Send browser push notification
let browserResult = null;
try {
  browserResult = await sendBrowserPushToUser(
    order.customer_id,
    title,
    body,
    "/"
  );
} catch (browserError) {
  console.error(
    "Customer browser push failed:",
    browserError.message
  );
}
// 🟢 10. Retrieve the customer's Expo push token
const { data: customerProfile, error: profileError } =
  await supabaseAdmin
    .from("profiles")
    .select("push_token")
    .eq("id", order.customer_id)
    .maybeSingle();
if (profileError) {
  console.error(
    "Customer push-token lookup failed:",
    profileError
  );
}
// 🟢 11. Send mobile push notification when a token exists
let mobileSent = false;
if (customerProfile?.push_token) {
  try {
    await sendPush(
      [customerProfile.push_token],
      title,
      body,
      {
        type: "restaurant_order_completed",
        order_id: order.id,
        restaurant_id: restaurant.id,
      }
    );
    mobileSent = true;
  } catch (mobileError) {
    console.error(
      "Customer mobile push failed:",
      mobileError.message
    );
  }
}
// 🟢 12. Return the result
return res.json({
  success: true,
  message: "Customer completion notification processed.",
  browser: browserResult,
  mobileSent,
});

} catch (error) {
console.error(
"Restaurant order-completed notification error:",
error
);

return res.status(500).json({
  success: false,
  message: "Customer notification failed.",
});

}
});

// ============================================================
// 🌾 FARM STOCK BROWSER PUSH NOTIFICATION
// ============================================================

app.post(
  "/farm-stock-browser-push",
  async (req, res) => {
    try {
      // ==========================================
      // 🔐 VERIFY AUTHENTICATED USER
      // ==========================================

      const authorization =
        req.headers.authorization || "";

      if (!authorization.startsWith("Bearer ")) {
        return res.status(401).json({
          success: false,
          error: "Authentication required.",
        });
      }

      const accessToken = authorization
        .slice(7)
        .trim();

      const {
        data: userData,
        error: authError,
      } = await supabaseAdmin.auth.getUser(
        accessToken
      );

      if (authError || !userData?.user) {
        return res.status(401).json({
          success: false,
          error: "Invalid or expired session.",
        });
      }

      const user = userData.user;

      // ==========================================
      // 📝 VALIDATE STOCK ID
      // ==========================================

      const stockId = Number(req.body?.stock_id);

      if (
        !Number.isSafeInteger(stockId) ||
        stockId <= 0
      ) {
        return res.status(400).json({
          success: false,
          error: "A valid stock_id is required.",
        });
      }

      // ==========================================
      // 🔎 VERIFY STOCK OWNERSHIP
      // ==========================================

      const {
        data: stock,
        error: stockError,
      } = await supabaseAdmin
        .from("farm_stocks")
        .select(
          "id, farm_id, user_id, product_name, quantity, unit, created_at"
        )
        .eq("id", stockId)
        .eq("user_id", user.id)
        .maybeSingle();

      if (stockError) {
        console.error(
          "Farm stock lookup failed:",
          stockError.message
        );

        return res.status(500).json({
          success: false,
          error: "Could not verify farm stock.",
        });
      }

      if (!stock) {
        return res.status(404).json({
          success: false,
          error:
            "Stock not found or you are not authorized to notify users about it.",
        });
      }

      // ==========================================
      // ⏱️ ONLY NOTIFY ABOUT RECENTLY CREATED STOCK
      // ==========================================

      const createdAt = new Date(
        stock.created_at
      ).getTime();

      const age = Date.now() - createdAt;

      if (
        !Number.isFinite(createdAt) ||
        age < -60000 ||
        age > 5 * 60 * 1000
      ) {
        return res.status(400).json({
          success: false,
          error:
            "Notifications can only be requested for recently created stock.",
        });
      }

      // ==========================================
      // 🌾 BUILD NOTIFICATION WITH FARM NAME
      // ==========================================

      // 🏡 GET THE FARM NAME
      const {
        data: farm,
        error: farmError,
      } = await supabaseAdmin
        .from("farm_profiles")
        .select("farm_name")
        .eq("id", stock.farm_id)
        .maybeSingle();

      if (farmError) {
        console.error(
          "Could not retrieve farm name:",
          farmError.message
        );
      }

      const farmName =
        farm?.farm_name || "A Nasara Farmer";

      // 🥚 GET THE PRODUCT NAME
      const productName =
        stock.product_name || "Farm Produce";

      // 📦 FORMAT THE AVAILABLE QUANTITY
      const quantity = Number(stock.quantity);

      const quantityText =
        stock.quantity !== null &&
        stock.quantity !== undefined &&
        stock.unit &&
        Number.isFinite(quantity)
          ? ` Available quantity: ${quantity} ${stock.unit}.`
          : "";

      // 🔔 CREATE THE NOTIFICATION
      const title =
        `🌾 New Stock from ${farmName}!`;

      const body =
        `${productName} has been added by ${farmName} on Nasara.` +
        quantityText;

      // 🔗 FARM DESTINATION
      const url = stock.farm_id
        ? `/farm/${stock.farm_id}`
        : "/";
      // ==========================================
      // 🔔 BROADCAST TO BROWSER SUBSCRIBERS
      // ==========================================

      const result = await broadcastBrowserPush(
        title,
        body,
        url,
        user.id
      );

      console.log(
        "🌾 FARM STOCK BROWSER NOTIFICATION:",
        JSON.stringify({
          stockId: stock.id,
          productName,
          sent: result.sent,
          failed: result.failed,
        })
      );

      return res.json({
        success: true,
        message:
          "Farm stock browser notification processed.",
        sent: result.sent,
        failed: result.failed,
      });
    } catch (error) {
      console.error(
        "Farm stock browser notification error:",
        error
      );

      return res.status(500).json({
        success: false,
        error:
          "Could not send farm stock notification.",
      });
    }
  }
);

// ============================================================
// 🔴 LIVEKIT GO LIVE BROWSER PUSH NOTIFICATION
// ============================================================

app.post(
  "/live-started-browser-push",
  async (req, res) => {
    try {
      // ==========================================
      // 🔐 VERIFY AUTHENTICATED USER
      // ==========================================

      const authorization =
        req.headers.authorization || "";

      if (!authorization.startsWith("Bearer ")) {
        return res.status(401).json({
          success: false,
          error: "Authentication required.",
        });
      }

      const accessToken =
        authorization.slice(7).trim();

      const {
        data: userData,
        error: authError,
      } = await supabaseAdmin.auth.getUser(
        accessToken
      );

      if (authError || !userData?.user) {
        return res.status(401).json({
          success: false,
          error: "Invalid or expired session.",
        });
      }

      const user = userData.user;

      // ==========================================
      // 📝 VALIDATE LIVE STREAM ID
      // ==========================================

      const streamId =
        String(req.body?.stream_id || "").trim();

      if (
        !streamId ||
        streamId.length > 100
      ) {
        return res.status(400).json({
          success: false,
          error: "A valid stream_id is required.",
        });
      }

      // ==========================================
      // 🔎 VERIFY STREAM OWNERSHIP AND STATUS
      // ==========================================

      const {
        data: stream,
        error: streamError,
      } = await supabaseAdmin
        .from("live_streams")
        .select(
          "id, user_id, title, status, is_active"
        )
        .eq("id", streamId)
        .eq("user_id", user.id)
        .maybeSingle();

      if (streamError) {
        console.error(
          "Live stream verification failed:",
          streamError.message
        );

        return res.status(500).json({
          success: false,
          error: "Could not verify live stream.",
        });
      }

      if (!stream) {
        return res.status(404).json({
          success: false,
          error:
            "Live stream not found or you are not authorized.",
        });
      }

      if (
        stream.status !== "live" ||
        stream.is_active !== true
      ) {
        return res.status(400).json({
          success: false,
          error: "This live stream is not active.",
        });
      }

      // ==========================================
      // 👤 GET BROADCASTER NAME
      // ==========================================

      const {
        data: profile,
        error: profileError,
      } = await supabaseAdmin
        .from("profiles")
        .select("full_name")
        .eq("id", user.id)
        .maybeSingle();

      if (profileError) {
        console.error(
          "Live broadcaster profile lookup failed:",
          profileError.message
        );
      }

      const broadcasterName =
        profile?.full_name || "A Nasara Creator";

      // ==========================================
      // 🔔 BUILD NOTIFICATION
      // ==========================================

      const title =
        `🔴 ${broadcasterName} is Live on Nasara!`;

      const body =
        stream.title ||
        `${broadcasterName} has started a live video. Join now!`;

      // ==========================================
      // 🔗 OPEN NASARA BROWSE
      // ==========================================

      const url = "/browse";

      // ==========================================
      // 📢 SEND TO BROWSER SUBSCRIBERS
      // EXCLUDE THE BROADCASTER
      // ==========================================

      const result = await broadcastBrowserPush(
        title,
        body,
        url,
        user.id
      );

      console.log(
        "🔴 LIVEKIT BROWSER NOTIFICATION:",
        JSON.stringify({
          streamId: stream.id,
          broadcaster: broadcasterName,
          sent: result.sent,
          failed: result.failed,
        })
      );

      return res.json({
        success: true,
        message:
          "Live stream browser notification processed.",
        sent: result.sent,
        failed: result.failed,
      });

    } catch (error) {
      console.error(
        "LiveKit browser notification error:",
        error
      );

      return res.status(500).json({
        success: false,
        error:
          "Could not send live stream notification.",
      });
    }
  }
);

// ============================================================
// 🔴 LIVEKIT LIVE STARTED — WEB + EXPO APP NOTIFICATIONS
// ============================================================

app.post(
  "/live-started-notification",
  async (req, res) => {
    try {
      // ==========================================
      // 🔐 VERIFY USER
      // ==========================================

      const authorization =
        req.headers.authorization || "";

      if (!authorization.startsWith("Bearer ")) {
        return res.status(401).json({
          success: false,
          error: "Authentication required.",
        });
      }

      const accessToken = authorization
        .slice(7)
        .trim();

      const {
        data: userData,
        error: authError,
      } = await supabaseAdmin.auth.getUser(
        accessToken
      );

      if (authError || !userData?.user) {
        return res.status(401).json({
          success: false,
          error: "Invalid or expired session.",
        });
      }

      const user = userData.user;

      // ==========================================
      // 📝 VALIDATE STREAM ID
      // ==========================================

      const streamId = String(
        req.body?.stream_id || ""
      ).trim();

      if (!streamId) {
        return res.status(400).json({
          success: false,
          error: "stream_id is required.",
        });
      }

      // ==========================================
      // 🔎 VERIFY STREAM OWNERSHIP AND STATUS
      // ==========================================

      const {
        data: stream,
        error: streamError,
      } = await supabaseAdmin
        .from("live_streams")
        .select("id, user_id, title, status, is_active")
        .eq("id", streamId)
        .eq("user_id", user.id)
        .maybeSingle();

      if (streamError) {
        console.error(
          "Live stream lookup failed:",
          streamError.message
        );

        return res.status(500).json({
          success: false,
          error: "Could not verify live stream.",
        });
      }

      if (
        !stream ||
        stream.status !== "live" ||
        stream.is_active !== true
      ) {
        return res.status(403).json({
          success: false,
          error: "This live stream is not active or authorized.",
        });
      }

      // ==========================================
      // 👤 GET HOST NAME
      // ==========================================

      const {
        data: profile,
      } = await supabaseAdmin
        .from("profiles")
        .select("full_name")
        .eq("id", user.id)
        .maybeSingle();

      const hostName =
        profile?.full_name || "A Nasara seller";

      // ==========================================
      // 🔔 BUILD NOTIFICATION
      // ==========================================

      const notificationTitle =
        `🔴 ${hostName} is Live on Nasara`;

      const notificationBody =
        stream.title ||
        "Join the live broadcast on Nasara.";

      const notificationUrl =
        `/browse?live=${encodeURIComponent(stream.id)}`;

      // ==========================================
      // 🌐 SEND TO WEB SUBSCRIBERS
      // ==========================================

      let browserResult = {
        sent: 0,
        failed: 0,
      };

      try {
        browserResult =
          await broadcastBrowserPush(
            notificationTitle,
            notificationBody,
            notificationUrl,
            user.id
          );
      } catch (browserError) {
        console.error(
          "Live browser push failed:",
          browserError.message
        );
      }

      // ==========================================
      // 📱 SEND TO EXPO APP USERS
      // ==========================================

      let mobileSent = false;

      try {
        const {
          data: appUsers,
          error: appUsersError,
        } = await supabaseAdmin
          .from("profiles")
          .select("push_token")
          .neq("id", user.id)
          .not("push_token", "is", null);

        if (appUsersError) {
          throw appUsersError;
        }

        const tokens = [
          ...new Set(
            (appUsers || [])
              .map((item) => item.push_token)
              .filter(
                (token) =>
                  typeof token === "string" &&
                  token.startsWith("ExponentPushToken")
              )
          ),
        ];

        if (tokens.length > 0) {
          await sendPush(
            tokens,
            notificationTitle,
            notificationBody,
            {
              type: "live_stream",
              stream_id: stream.id,
              url: notificationUrl,
            }
          );

          mobileSent = true;
        }
      } catch (mobileError) {
        console.error(
          "Live Expo push failed:",
          mobileError.message
        );
      }

      // ==========================================
      // ✅ RETURN RESULT
      // ==========================================

      return res.json({
        success: true,
        message: "Live notifications processed.",
        browser: browserResult,
        mobileSent,
      });
    } catch (error) {
      console.error(
        "Live notification error:",
        error
      );

      return res.status(500).json({
        success: false,
        error: "Could not process live notifications.",
      });
    }
  }
);

// ============================================================
// 📇 NASARA CONTACTS — SECURE BACKEND
// 🔵 Uses existing supabaseAdmin
// 🔵 Uses existing verified phone numbers
// 🔵 Supports Ghanaian and international phone formats
// 🔵 Protects election phone identity
// 🔵 Does not create chat rooms
// 🔵 Does not expose phone numbers
// ============================================================


// ==========================================
// 🔐 AUTHENTICATE CONTACTS REQUEST
// ==========================================

async function authenticateContactsRequest(req, res) {
  const authorization =
    req.headers.authorization || "";

  if (!authorization.startsWith("Bearer ")) {
    res.status(401).json({
      success: false,
      error: "Authentication required.",
    });

    return null;
  }

  const accessToken =
    authorization.slice(7).trim();

  const {
    data,
    error,
  } = await supabaseAdmin.auth.getUser(accessToken);

  if (error || !data?.user) {
    res.status(401).json({
      success: false,
      error: "Invalid or expired session.",
    });

    return null;
  }

  return data.user;
}


// ==========================================
// 📞 NORMALIZE PHONE NUMBER
// ==========================================

function normalizeNasaraPhone(
  phone,
  defaultCountry = "GH"
) {
  if (
    typeof phone !== "string" ||
    !phone.trim()
  ) {
    return null;
  }

  try {
    const cleanedPhone =
      phone.trim().replace(/[^\d+]/g, "");

    const parsed =
      parsePhoneNumberFromString(
        cleanedPhone,
        defaultCountry
      );

    if (!parsed || !parsed.isValid()) {
      return null;
    }

    // Always return international E.164 format.
    return parsed.number;
  } catch (error) {
    return null;
  }
}


// ==========================================
// 👤 SAFE PUBLIC CONTACT PROFILE
// ==========================================

function safeContactProfile(profile) {
  if (!profile) return null;

  return {
    id: profile.id,
    full_name: profile.full_name || "Nasara User",
    avatar_url: profile.avatar_url || null,
    verified: profile.verified === true,
  };
}


// ============================================================
// 📇 GET MY SAVED CONTACTS
// GET /contacts
// ============================================================

app.get(
  "/contacts",
  async (req, res) => {
    try {
      const user =
        await authenticateContactsRequest(req, res);

      if (!user) return;

      // ==========================================
      // 📂 GET CONTACT RELATIONSHIPS
      // ==========================================

      const {
        data: savedContacts,
        error: contactsError,
      } = await supabaseAdmin
        .from("user_contacts")
        .select("contact_user_id, created_at")
        .eq("owner_user_id", user.id)
        .order("created_at", {
          ascending: false,
        });

      if (contactsError) {
        console.error(
          "Contacts retrieval error:",
          contactsError
        );

        return res.status(500).json({
          success: false,
          error: "Could not load your contacts.",
        });
      }

      const contactIds =
        (savedContacts || []).map(
          (item) => item.contact_user_id
        );

      if (contactIds.length === 0) {
        return res.json({
          success: true,
          contacts: [],
        });
      }

      // ==========================================
      // 🔐 ONLY RETURN VERIFIED ACCOUNTS
      // Existing contacts remain visible even if
      // phone discovery is later disabled.
      // ==========================================

      const {
        data: profiles,
        error: profilesError,
      } = await supabaseAdmin
        .from("profiles")
        .select(
          "id, full_name, avatar_url, verified, phone_verified"
        )
        .in("id", contactIds)
        .eq("phone_verified", true);

      if (profilesError) {
        console.error(
          "Contact profile lookup error:",
          profilesError
        );

        return res.status(500).json({
          success: false,
          error: "Could not load contact profiles.",
        });
      }

      const profileMap = new Map(
        (profiles || []).map((profile) => [
          profile.id,
          safeContactProfile(profile),
        ])
      );

      const contacts =
        (savedContacts || [])
          .map((item) => {
            const profile =
              profileMap.get(item.contact_user_id);

            if (!profile) return null;

            return {
              ...profile,
              created_at: item.created_at,
            };
          })
          .filter(Boolean);

      return res.json({
        success: true,
        contacts,
        count: contacts.length,
      });

    } catch (error) {
      console.error(
        "GET contacts error:",
        error
      );

      return res.status(500).json({
        success: false,
        error: "Could not load contacts.",
      });
    }
  }
);


// ============================================================
// 🔎 LOOK UP NASARA USERS BY PHONE NUMBER
// POST /contacts/lookup
// ============================================================

app.post(
  "/contacts/lookup",
  async (req, res) => {
    try {
      const user =
        await authenticateContactsRequest(req, res);

      if (!user) return;

      // ==========================================
      // 📥 ACCEPT PHONE NUMBERS
      // ==========================================

      const inputNumbers =
        Array.isArray(req.body?.phone_numbers)
          ? req.body.phone_numbers
          : [req.body?.phone_number];

      if (
        inputNumbers.length === 0 ||
        inputNumbers.length > 100
      ) {
        return res.status(400).json({
          success: false,
          error:
            "Submit between 1 and 100 phone numbers.",
        });
      }

      const defaultCountry =
        String(
          req.body?.default_country || "GH"
        ).toUpperCase();

      if (!/^[A-Z]{2}$/.test(defaultCountry)) {
        return res.status(400).json({
          success: false,
          error: "Invalid default country code.",
        });
      }

      // ==========================================
      // 📞 NORMALIZE SUBMITTED NUMBERS
      // ==========================================

      const normalizedNumbers = [
        ...new Set(
          inputNumbers
            .map((phone) =>
              normalizeNasaraPhone(
                phone,
                defaultCountry
              )
            )
            .filter(Boolean)
        ),
      ];

      if (normalizedNumbers.length === 0) {
        return res.json({
          success: true,
          matches: [],
          count: 0,
          message: "No valid phone numbers found.",
        });
      }

      // ==========================================
// 🔐 MATCH ALL VERIFIED NASARA USERS
// No discovery toggle required.
// ==========================================

const {
  data: profiles,
  error: profilesError,
} = await supabaseAdmin
  .from("profiles")
  .select(
    "id, full_name, avatar_url, verified, phone"
  )
  .eq("phone_verified", true)
  .not("phone", "is", null)
  .limit(10000);

      if (profilesError) {
        console.error(
          "Phone discovery error:",
          profilesError
        );

        return res.status(500).json({
          success: false,
          error: "Could not search Nasara contacts.",
        });
      }

      // ==========================================
      // 🔎 MATCH NORMALIZED PHONE NUMBERS
      // ==========================================

      const submittedSet =
        new Set(normalizedNumbers);

      const matches = [];

      for (const profile of profiles || []) {
        // Never return the signed-in user.
        if (profile.id === user.id) {
          continue;
        }

        const storedNumber =
          normalizeNasaraPhone(
            profile.phone,
            defaultCountry
          );

        if (
          storedNumber &&
          submittedSet.has(storedNumber)
        ) {
          matches.push(
            safeContactProfile(profile)
          );
        }
      }

      // ==========================================
      // 🔐 REMOVE ALREADY SAVED CONTACTS
      // ==========================================

      const {
        data: existingContacts,
        error: existingError,
      } = await supabaseAdmin
        .from("user_contacts")
        .select("contact_user_id")
        .eq("owner_user_id", user.id);

      if (existingError) {
        console.error(
          "Existing contacts lookup error:",
          existingError
        );

        return res.status(500).json({
          success: false,
          error: "Could not check saved contacts.",
        });
      }

      const existingIds = new Set(
        (existingContacts || []).map(
          (item) => item.contact_user_id
        )
      );

      const filteredMatches =
        matches.filter(
          (profile) => !existingIds.has(profile.id)
        );

      return res.json({
        success: true,
        matches: filteredMatches,
        count: filteredMatches.length,
      });

    } catch (error) {
      console.error(
        "Phone lookup error:",
        error
      );

      return res.status(500).json({
        success: false,
        error: "Phone lookup failed.",
      });
    }
  }
);


// ============================================================
// ➕ ADD CONTACT
// POST /contacts/add
// ============================================================

app.post(
  "/contacts/add",
  async (req, res) => {
    try {
      const user =
        await authenticateContactsRequest(req, res);

      if (!user) return;

      const contactUserId =
        String(
          req.body?.contact_user_id || ""
        ).trim();

      if (!contactUserId) {
        return res.status(400).json({
          success: false,
          error: "Contact user ID is required.",
        });
      }

      if (contactUserId === user.id) {
        return res.status(400).json({
          success: false,
          error: "You cannot add yourself.",
        });
      }

      // ==========================================
// 🔐 VERIFY TARGET NASARA ACCOUNT
// Only phone verification is required.
// ==========================================

const {
  data: contactProfile,
  error: profileError,
} = await supabaseAdmin
  .from("profiles")
  .select(
    "id, full_name, avatar_url, verified, phone_verified"
  )
  .eq("id", contactUserId)
  .eq("phone_verified", true)
  .maybeSingle();

      if (profileError) {
        console.error(
          "Contact verification error:",
          profileError
        );

        return res.status(500).json({
          success: false,
          error: "Could not verify contact account.",
        });
      }

      if (!contactProfile) {
        return res.status(404).json({
          success: false,
          error:
            "Verified contact not found or unavailable.",
        });
      }

      // ==========================================
      // 💾 SAVE CONTACT RELATIONSHIP
      // No phone number is modified.
      // No chat room is created.
      // ==========================================

      const {
        data: savedContact,
        error: saveError,
      } = await supabaseAdmin
        .from("user_contacts")
        .upsert(
          {
            owner_user_id: user.id,
            contact_user_id: contactUserId,
          },
          {
            onConflict:
              "owner_user_id,contact_user_id",
            ignoreDuplicates: true,
          }
        )
        .select("id, created_at")
        .maybeSingle();

      if (saveError) {
        console.error(
          "Add contact error:",
          saveError
        );

        return res.status(500).json({
          success: false,
          error: "Could not add contact.",
        });
      }

      return res.json({
        success: true,
        message: "Contact added successfully.",
        contact: {
          ...safeContactProfile(contactProfile),
          created_at:
            savedContact?.created_at || null,
        },
      });

    } catch (error) {
      console.error(
        "Add contact error:",
        error
      );

      return res.status(500).json({
        success: false,
        error: "Could not add contact.",
      });
    }
  }
);


// ============================================================
// ➖ REMOVE CONTACT
// DELETE /contacts/:contactUserId
// ============================================================

app.delete(
  "/contacts/:contactUserId",
  async (req, res) => {
    try {
      const user =
        await authenticateContactsRequest(req, res);

      if (!user) return;

      const contactUserId =
        String(
          req.params.contactUserId || ""
        ).trim();

      if (!contactUserId) {
        return res.status(400).json({
          success: false,
          error: "Contact user ID is required.",
        });
      }

      // Only the owner can remove their contact.
      const {
        error: deleteError,
      } = await supabaseAdmin
        .from("user_contacts")
        .delete()
        .eq("owner_user_id", user.id)
        .eq("contact_user_id", contactUserId);

      if (deleteError) {
        console.error(
          "Remove contact error:",
          deleteError
        );

        return res.status(500).json({
          success: false,
          error: "Could not remove contact.",
        });
      }

      return res.json({
        success: true,
        message: "Contact removed.",
      });

    } catch (error) {
      console.error(
        "Remove contact error:",
        error
      );

      return res.status(500).json({
        success: false,
        error: "Could not remove contact.",
      });
    }
  }
);


// ============================================================
// 🔐 PHONE DISCOVERY — OPT IN / OPT OUT
// PATCH /contacts/discovery
// ============================================================

app.patch(
  "/contacts/discovery",
  async (req, res) => {
    try {
      const user =
        await authenticateContactsRequest(req, res);

      if (!user) return;

      const enabled =
        req.body?.enabled;

      if (typeof enabled !== "boolean") {
        return res.status(400).json({
          success: false,
          error: "enabled must be true or false.",
        });
      }

      // ==========================================
      // 🔐 ONLY VERIFIED USERS CAN OPT IN
      // Opting out is always allowed.
      // ==========================================

      let updateQuery =
        supabaseAdmin
          .from("profiles")
          .update({
            phone_discoverable: enabled,
          })
          .eq("id", user.id);

      if (enabled === true) {
        updateQuery =
          updateQuery.eq("phone_verified", true);
      }

      const {
        data: updatedProfile,
        error: updateError,
      } = await updateQuery
        .select("id")
        .maybeSingle();

      if (updateError) {
        console.error(
          "Phone discovery update error:",
          updateError
        );

        return res.status(500).json({
          success: false,
          error: "Could not update discovery setting.",
        });
      }

      if (!updatedProfile) {
        return res.status(403).json({
          success: false,
          error:
            "You must verify your phone number before enabling phone discovery.",
        });
      }

      return res.json({
        success: true,
        phone_discoverable: enabled,
        message: enabled
          ? "Phone discovery enabled."
          : "Phone discovery disabled.",
      });

    } catch (error) {
      console.error(
        "Phone discovery setting error:",
        error
      );

      return res.status(500).json({
        success: false,
        error: "Could not update discovery setting.",
      });
    }
  }
);

/* ================= HOSPITAL ROUTES ================= */
app.use("/hospital", hospitalRoutes);

/* ================= RESTAURANT ROUTES ================= */
app.use("/restaurant", restaurantRoutes);

// ============================================================
// NETLIFY WEBSITE PUBLISHING
// ============================================================

function createNetlifySiteName(siteName, websiteId) {
  const cleanName = String(siteName || "website")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);

  const shortId = String(websiteId || "")
    .replace(/[^a-zA-Z0-9]/g, "")
    .slice(-8)
    .toLowerCase();

  return `${cleanName || "website"}-${shortId}`;
}


// ============================================================
// CREATE NETLIFY ZIP
// ============================================================

function createNetlifyZip(html) {
  try {
    console.log(
      "Creating Netlify ZIP using ADM-ZIP..."
    );

    const zip = new AdmZip();

    // ==========================================
    // MAIN CUSTOMER WEBSITE
    // ==========================================

    zip.addFile(
      "index.html",
      Buffer.from(
        html,
        "utf8"
      )
    );

    const zipBuffer =
      zip.toBuffer();

    console.log(
      "Netlify ZIP created successfully."
    );

    console.log(
      "ZIP size:",
      zipBuffer.length,
      "bytes"
    );

    return zipBuffer;

  } catch (error) {

    console.error(
      "Failed to create Netlify ZIP:",
      error
    );

    throw error;
  }
}
// ============================================================
// PUBLISH WEBSITE TO NETLIFY
// ============================================================

app.post(
  "/publish-website-to-netlify",
  async (req, res) => {
    try {
      console.log(
        "================================================"
      );

      console.log(
        "NETLIFY WEBSITE PUBLISH REQUEST"
      );

      console.log(
        "================================================"
      );


      // ======================================================
      // CHECK NETLIFY TOKEN
      // ======================================================

      if (!process.env.NETLIFY_AUTH_TOKEN) {
        console.error(
          "NETLIFY_AUTH_TOKEN is missing."
        );

        return res.status(500).json({
          success: false,
          error:
            "NETLIFY_AUTH_TOKEN is not configured on the server.",
        });
      }


      // ======================================================
      // CHECK USER AUTHORIZATION HEADER
      // ======================================================

      const authorization =
        req.headers.authorization || "";

      if (
        !authorization.startsWith("Bearer ")
      ) {
        console.error(
          "Missing user authorization header."
        );

        return res.status(401).json({
          success: false,
          error:
            "Missing authorization token.",
        });
      }


      const accessToken =
        authorization
          .replace("Bearer ", "")
          .trim();


      if (!accessToken) {
        return res.status(401).json({
          success: false,
          error:
            "Invalid authorization token.",
        });
      }


      console.log(
        "User authorization token received."
      );


      // ======================================================
      // VERIFY USER WITH SUPABASE
      // ======================================================

      const {
        data: userData,
        error: userError,
      } =
        await websiteGeneratorAdmin.auth.getUser(
          accessToken
        );


      if (
        userError ||
        !userData?.user
      ) {
        console.error(
          "Website generator auth error:",
          userError
        );

        return res.status(401).json({
          success: false,
          error:
            "Invalid or expired login session.",
        });
      }


      const user = userData.user;


      console.log(
        "Authenticated user:",
        user.id
      );


      // ======================================================
      // VERIFY GENERATOR ADMIN
      // ======================================================

      const {
        data: generatorAdmin,
        error: generatorAdminError,
      } =
        await websiteGeneratorAdmin
          .from("generator_admins")
          .select(
            "id, auth_user_id, full_name, email, role, status"
          )
          .eq(
            "auth_user_id",
            user.id
          )
          .eq(
            "status",
            "active"
          )
          .maybeSingle();


      if (
        generatorAdminError ||
        !generatorAdmin
      ) {
        console.error(
          "Generator admin verification error:",
          generatorAdminError
        );

        return res.status(403).json({
          success: false,
          error:
            "You are not authorized to publish websites.",
        });
      }


      console.log(
        "Generator admin verified:",
        generatorAdmin.full_name ||
          generatorAdmin.email
      );


      // ======================================================
      // READ REQUEST BODY
      // ======================================================

      const {
        website_id,
        site_name,
        html,
      } = req.body || {};


      console.log(
        "Website ID:",
        website_id
      );

      console.log(
        "Site name:",
        site_name
      );

      console.log(
        "HTML received:",
        typeof html === "string"
      );

      if (!website_id) {
        return res.status(400).json({
          success: false,
          error:
            "website_id is required.",
        });
      }


      if (
        !html ||
        typeof html !== "string"
      ) {
        return res.status(400).json({
          success: false,
          error:
            "Generated HTML is required.",
        });
      }


      if (
        html.length >
        20 * 1024 * 1024
      ) {
        return res.status(400).json({
          success: false,
          error:
            "Generated website HTML is too large.",
        });
      }


      console.log(
        "HTML size:",
        html.length,
        "characters"
      );


      // ======================================================
      // LOAD WEBSITE FROM DATABASE
      // ======================================================

      const {
        data: website,
        error: websiteError,
      } =
        await websiteGeneratorAdmin
          .from("websites")
          .select(
            `
              id,
              name,
              website_type,
              published_url,
              netlify_site_id
            `
          )
          .eq(
            "id",
            website_id
          )
          .maybeSingle();


      if (websiteError) {
        console.error(
          "Website lookup error:",
          websiteError
        );

        return res.status(500).json({
          success: false,
          error:
            "Could not load website.",
        });
      }


      if (!website) {
        return res.status(404).json({
          success: false,
          error:
            "Website was not found.",
        });
      }


      console.log(
        "Website found:",
        website.name
      );

      console.log(
        "Existing Netlify site ID:",
        website.netlify_site_id || "NONE"
      );


      // ======================================================
      // CREATE ZIP
      // ======================================================

      console.log(
        "Creating Netlify ZIP..."
      );


      const zipBuffer =
        await createNetlifyZip(
          html
        );


      console.log(
        "ZIP ready."
      );

      console.log(
        "ZIP size:",
        zipBuffer.length,
        "bytes"
      );


      // ======================================================
      // CHECK EXISTING NETLIFY SITE
      // ======================================================

      let netlifySiteId =
        website.netlify_site_id ||
        null;

      let netlifySite =
        null;


      if (netlifySiteId) {
        console.log(
          "Checking existing Netlify site:",
          netlifySiteId
        );


        const siteResponse =
          await fetch(
            `https://api.netlify.com/api/v1/sites/${encodeURIComponent(
              netlifySiteId
            )}`,
            {
              method: "GET",

              headers: {
                Authorization:
                 `Bearer ${process.env.NETLIFY_AUTH_TOKEN}`,

                Accept:
                  "application/json",
              },
            }
          );


        if (siteResponse.ok) {
          netlifySite =
            await siteResponse.json();


          console.log(
            "Existing Netlify site found."
          );


          console.log(
            "Netlify site URL:",
            netlifySite?.ssl_url ||
              netlifySite?.url ||
              "not available"
          );
        } else {
          const existingSiteError =
            await siteResponse.text();


          console.warn(
            "Existing Netlify site could not be loaded."
          );


          console.warn(
            "Netlify status:",
            siteResponse.status
          );


          console.warn(
            "Netlify response:",
            existingSiteError
          );


          netlifySiteId =
            null;
        }
      }


      // ======================================================
      // CREATE NETLIFY SITE IF NEEDED
      // ======================================================

      if (!netlifySiteId) {
        const netlifySiteName =
          createNetlifySiteName(
            site_name ||
              website.name,
            website.id
          );


        console.log(
          "Creating new Netlify site..."
        );


        console.log(
          "Netlify site name:",
          netlifySiteName
        );


        const createSiteResponse =
          await fetch(
            "https://api.netlify.com/api/v1/sites",
            {
              method: "POST",

              headers: {
                Authorization:
                  `Bearer ${process.env.NETLIFY_AUTH_TOKEN}`,

                "Content-Type":
                  "application/json",

                Accept:
                  "application/json",
              },

              body: JSON.stringify({
                name:
                  netlifySiteName,
              }),
            }
          );


        const createSiteText =
          await createSiteResponse.text();


        let createSiteData =
          null;


        try {
          createSiteData =
            createSiteText
              ? JSON.parse(
                  createSiteText
                )
              : null;
        } catch {
          createSiteData =
            null;
        }


        if (
          !createSiteResponse.ok
        ) {
          console.error(
            "Netlify site creation failed:"
          );

          console.error(
            "Status:",
            createSiteResponse.status
          );

          console.error(
            "Response:",
            createSiteText
          );


          return res.status(502).json({
            success: false,
            error:
              createSiteData?.message ||
              createSiteData?.error ||
              "Netlify site creation failed.",
          });
        }


        netlifySite =
          createSiteData;


        netlifySiteId =
          netlifySite?.id ||
          null;


        if (!netlifySiteId) {
          console.error(
            "Netlify created the site but returned no site ID."
          );


          return res.status(502).json({
            success: false,
            error:
              "Netlify created the site but did not return a site ID.",
          });
        }


        console.log(
          "New Netlify site created:"
        );

        console.log(
          "Site ID:",
          netlifySiteId
        );

        console.log(
          "Site URL:",
          netlifySite?.ssl_url ||
            netlifySite?.url ||
            "not available"
        );
      }


      // ======================================================
      // DEPLOY ZIP TO NETLIFY
      // ======================================================

      console.log(
        "Deploying website to Netlify..."
      );


      console.log(
        "Netlify site ID:",
        netlifySiteId
      );
      console.log(
  "ZIP first bytes:",
  zipBuffer.subarray(0, 10).toString("hex")
);

console.log(
  "ZIP is Buffer:",
  Buffer.isBuffer(zipBuffer)
);

console.log(
  "ZIP byte length:",
  zipBuffer.length
);

      const deployResponse =
        await fetch(
          `https://api.netlify.com/api/v1/sites/${encodeURIComponent(
            netlifySiteId
          )}/deploys`,
          {
            method: "POST",

            headers: {
              Authorization:
                `Bearer ${process.env.NETLIFY_AUTH_TOKEN}`,

              "Content-Type":
                "application/zip",

              Accept:
                "application/json",
            },

            body: zipBuffer,
          }
        );


      const deployText =
        await deployResponse.text();


      let deployData =
        null;


      try {
        deployData =
          deployText
            ? JSON.parse(
                deployText
              )
            : null;
      } catch {
        deployData =
          null;
      }


      // ======================================================
      // DEPLOYMENT ERROR
      // ======================================================

      if (
        !deployResponse.ok
      ) {
        console.error(
          "Netlify deployment failed."
        );


        console.error(
          "Status:",
          deployResponse.status
        );


        console.error(
          "Response:",
          deployText
        );


        return res.status(502).json({
          success: false,
          error:
            deployData?.message ||
            deployData?.error ||
            "Netlify deployment failed.",
        });
      }


      console.log(
        "Netlify deployment request accepted."
      );


      console.log(
        "Deploy ID:",
        deployData?.id ||
          "not returned"
      );


      console.log(
        "Deploy state:",
        deployData?.state ||
          "unknown"
      );


      // ======================================================
      // GET PUBLISHED URL
      // ======================================================

      const publishedUrl =
        deployData?.ssl_url ||
        deployData?.url ||
        deployData?.deploy_url ||
        netlifySite?.ssl_url ||
        netlifySite?.url ||
        "";


      if (!publishedUrl) {
        console.error(
          "Netlify deployment succeeded but no URL was returned."
        );


        return res.status(502).json({
          success: false,
          error:
            "Website was deployed, but Netlify did not return a published URL.",

          netlify_site_id:
            netlifySiteId,

          deploy_id:
            deployData?.id ||
            null,
        });
      }


      console.log(
        "Published URL:",
        publishedUrl
      );


      // ======================================================
      // SAVE NETLIFY INFORMATION TO SUPABASE
      // ======================================================

      console.log(
        "Saving Netlify information to database..."
      );


      const {
        data: updatedWebsite,
        error: updateWebsiteError,
      } =
        await websiteGeneratorAdmin
          .from("websites")
          .update({
            published_url:
              publishedUrl,

            netlify_site_id:
              netlifySiteId,

            updated_at:
              new Date().toISOString(),
          })
          .eq(
            "id",
            website_id
          )
          .select(
            `
              id,
              name,
              published_url,
              netlify_site_id
            `
          )
          .single();


      if (updateWebsiteError) {
        console.error(
          "Could not save Netlify information:"
        );


        console.error(
          updateWebsiteError
        );


        return res.status(500).json({
          success: false,

          error:
            "Website was deployed, but the published URL could not be saved.",

          published_url:
            publishedUrl,

          netlify_site_id:
            netlifySiteId,
        });
      }


      // ======================================================
      // SUCCESS
      // ======================================================

      console.log(
        "================================================"
      );

      console.log(
        "WEBSITE SUCCESSFULLY PUBLISHED"
      );

      console.log(
        "Website:",
        website.name
      );

      console.log(
        "Netlify Site ID:",
        netlifySiteId
      );

      console.log(
        "Published URL:",
        publishedUrl
      );

      console.log(
        "Deploy ID:",
        deployData?.id ||
          null
      );

      console.log(
        "================================================"
      );


      return res.json({
        success: true,

        message:
          "Website published successfully.",

        website:
          updatedWebsite,

        published_url:
          publishedUrl,

        netlify_site_id:
          netlifySiteId,

        deploy_id:
          deployData?.id ||
          null,

        deploy_state:
          deployData?.state ||
          null,
      });
    } catch (error) {
      console.error(
        "================================================"
      );

      console.error(
        "PUBLISH WEBSITE TO NETLIFY ERROR"
      );

      console.error(
        error
      );

      console.error(
        "================================================"
      );


      return res.status(500).json({
        success: false,

        error:
          error?.message ||
          "Unexpected error while publishing website.",
      });
    }
  }
);

// ==========================================
// 🎬 COMBINE TWO VIDEOS AND UPLOAD TO R2
// ==========================================

app.post(
  "/combine-videos",
  upload.array("videos", 2),
  async (req, res) => {
    const tempDir = path.join(
      os.tmpdir(),
      `nasara-combine-${crypto.randomBytes(8).toString("hex")}`
    );

    try {
      // ==========================================
      // 📁 VALIDATE SELECTED VIDEOS
      // ==========================================

      const files = req.files;

      if (!files || files.length !== 2) {
        return res.status(400).json({
          success: false,
          message: "Please upload exactly two videos.",
        });
      }

      for (const file of files) {
        if (!file.mimetype.startsWith("video/")) {
          return res.status(400).json({
            success: false,
            message: "Both uploaded files must be videos.",
          });
        }
      }

      // ==========================================
      // 📂 CREATE TEMPORARY DIRECTORY
      // ==========================================

      fs.mkdirSync(tempDir, { recursive: true });

      const firstPath = path.join(tempDir, "first.mp4");
      const secondPath = path.join(tempDir, "second.mp4");
      const outputPath = path.join(tempDir, "combined.mp4");
      const listPath = path.join(tempDir, "videos.txt");

      fs.writeFileSync(firstPath, files[0].buffer);
      fs.writeFileSync(secondPath, files[1].buffer);

      // ==========================================
      // 📝 CREATE FFmpeg CONCATENATION LIST
      // ==========================================

      const escapePath = (filePath) =>
        filePath.replace(/\\/g, "/").replace(/'/g, "'\\''");

      fs.writeFileSync(
        listPath,
        `file '${escapePath(firstPath)}'\nfile '${escapePath(secondPath)}'\n`
      );

      // ==========================================
      // 🎞️ COMBINE VIDEOS USING FFmpeg
      // ==========================================

      await new Promise((resolve, reject) => {
        const ffmpeg = spawn(ffmpegPath, [
          "-y",
          "-f",
          "concat",
          "-safe",
          "0",
          "-i",
          listPath,
          "-c:v",
          "libx264",
          "-preset",
          "veryfast",
          "-crf",
          "23",
          "-c:a",
          "aac",
          "-b:a",
          "128k",
          "-movflags",
          "+faststart",
          outputPath,
        ]);

        let errorOutput = "";

        ffmpeg.stderr.on("data", (data) => {
          errorOutput += data.toString();
        });

        ffmpeg.on("error", reject);

        ffmpeg.on("close", (code) => {
          if (code === 0 && fs.existsSync(outputPath)) {
            resolve();
          } else {
            reject(
              new Error(
                errorOutput.slice(-3000) ||
                  `FFmpeg exited with code ${code}`
              )
            );
          }
        });
      });

     // ==========================================
// ☁️ UPLOAD COMBINED VIDEO TO CLOUDFLARE R2
// ==========================================

const fileName = `combined-videos/${Date.now()}-${crypto.randomBytes(5).toString("hex")}.mp4`;

await s3
  .upload({
    Bucket: process.env.R2_BUCKET,
    Key: fileName,
    Body: fs.readFileSync(outputPath),
    ContentType: "video/mp4",
  })
  .promise();

const publicUrl =
  `https://${process.env.R2_PUBLIC_DOMAIN}/${fileName}`;

// ==========================================
// ✅ RETURN FINAL VIDEO URL
// ==========================================

res.json({
  success: true,
  message: "Videos combined successfully.",
  url: publicUrl,
  key: fileName,
});
    } catch (error) {
      console.error("Video combination error:", error);

      res.status(500).json({
        success: false,
        message: "Failed to combine videos.",
        error: error.message,
      });
    } finally {
      // ==========================================
      // 🧹 DELETE TEMPORARY FILES
      // ==========================================

      try {
        fs.rmSync(tempDir, {
          recursive: true,
          force: true,
        });
      } catch (cleanupError) {
        console.error(
          "Temporary video cleanup error:",
          cleanupError
        );
      }
    }
  }
);
/* ================= HEALTH CHECK (OPTIONAL BUT USEFUL) ================= */
app.get("/", (req, res) => {
  res.send("Nasara upload server running 🚀");
});

// ============================================================
// 🛍️ NASARA FRIDAY MARKET AUTOMATIC REMINDER
// 🛍️ ANDROID + WEB PUSH
// 🛍️ FRIDAY 9:00 AM + RENDER STARTUP CATCH-UP
// 🇬🇭 AFRICA/ACCRA TIMEZONE
// ============================================================

const cron = require("node-cron");

const FRIDAY_MARKET_CRON = "0 9 * * 5";

let fridayMarketReminderRunning = false;

// ------------------------------------------------------------
// GHANA DATE AND TIME
// ------------------------------------------------------------

function getGhanaDateTime() {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Africa/Accra",
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date());

  const values = {};

  for (const part of parts) {
    values[part.type] = part.value;
  }

  return {
    weekday: values.weekday,
    date: `${values.year}-${values.month}-${values.day}`,
    hour: Number(values.hour),
    minute: Number(values.minute),
  };
}

// ------------------------------------------------------------
// SEND FRIDAY MARKET NOTIFICATION
// ------------------------------------------------------------

async function sendFridayMarketReminder() {
  if (fridayMarketReminderRunning) {
    console.log("🟡 Friday Market reminder already running.");
    return;
  }

  const ghanaTime = getGhanaDateTime();

  if (ghanaTime.weekday !== "Fri") {
    console.log("🟡 Today is not Friday. Skipping.");
    return;
  }

  if (ghanaTime.hour < 9) {
    console.log("🟡 Friday Market reminder time has not arrived.");
    return;
  }

  fridayMarketReminderRunning = true;

  const marketDate = ghanaTime.date;

  let claimed = false;

  const title = "🛍️ Nasara Friday Market Is Open!";

  const body =
    "It's Friday! Visit Nasara to discover products, connect with sellers, and explore Friday Market discounted deals.";

  try {
    console.log("================================================");
    console.log("🛍️ FRIDAY MARKET REMINDER STARTED");
    console.log("Ghana date:", marketDate);

    // --------------------------------------------------------
    // CLAIM THIS FRIDAY'S NOTIFICATION
    // Prevent duplicate sends after Render restarts.
    // --------------------------------------------------------

    const { error: claimError } = await supabaseAdmin
      .from("friday_market_notifications")
      .insert({
        market_date: marketDate,
        status: "processing",
      });

    if (claimError) {
      if (claimError.code === "23505") {
        console.log(
          "🟡 Friday Market notification already claimed:",
          marketDate
        );
        return;
      }

      throw claimError;
    }

    claimed = true;

    // --------------------------------------------------------
    // 1. SEND WEB BROWSER PUSH
    // --------------------------------------------------------

    let browserResult = null;

    try {
      browserResult = await broadcastBrowserPush(
        title,
        body,
        "/"
      );

      console.log(
        "🌐 FRIDAY MARKET BROWSER PUSH:",
        JSON.stringify(browserResult)
      );
    } catch (error) {
      console.error(
        "🔴 Browser push failed:",
        error.message || error
      );
    }

    // --------------------------------------------------------
    // 2. GET REGISTERED NASARA USERS
    // --------------------------------------------------------

    const { data: users, error: usersError } =
      await supabaseAdmin
        .from("profiles")
        .select("id")
        .not("push_token", "is", null);

    if (usersError) {
      throw usersError;
    }

    console.log(
      "📱 Registered Android push users:",
      users?.length || 0
    );

    // --------------------------------------------------------
    // 3. SEND ANDROID EXPO PUSH
    // Reuse your existing notifyUser helper.
    // --------------------------------------------------------

    const mobileResults = await Promise.allSettled(
      (users || []).map((user) =>
        notifyUser(user.id, title, body)
      )
    );

    const mobileSent = mobileResults.filter(
      (result) => result.status === "fulfilled"
    ).length;

    const mobileFailed = mobileResults.filter(
      (result) => result.status === "rejected"
    ).length;

    console.log("📱 FRIDAY MARKET ANDROID PUSH RESULT:");
    console.log("Successful calls:", mobileSent);
    console.log("Failed calls:", mobileFailed);

    // --------------------------------------------------------
    // 4. SAVE RESULT
    // --------------------------------------------------------

    const { error: updateError } = await supabaseAdmin
      .from("friday_market_notifications")
      .update({
        status: "sent",
        sent_at: new Date().toISOString(),
      })
      .eq("market_date", marketDate);

    if (updateError) {
      throw updateError;
    }

    console.log("🟢 FRIDAY MARKET REMINDER COMPLETED");
    console.log("Browser result:", JSON.stringify(browserResult));
    console.log("Android calls:", mobileSent);
    console.log("Android failures:", mobileFailed);
    console.log("================================================");

  } catch (error) {
    console.error(
      "🔴 FRIDAY MARKET REMINDER ERROR:",
      error
    );

    // Keep the claim so a restart cannot accidentally
    // send duplicate notifications after partial delivery.
    if (claimed) {
      await supabaseAdmin
        .from("friday_market_notifications")
        .update({
          status: "failed",
        })
        .eq("market_date", marketDate);
    }

  } finally {
    fridayMarketReminderRunning = false;
  }
}

// ------------------------------------------------------------
// FRIDAY 9:00 AM GHANA SCHEDULE
// ------------------------------------------------------------

cron.schedule(
  FRIDAY_MARKET_CRON,
  async () => {
    await sendFridayMarketReminder();
  },
  {
    timezone: "Africa/Accra",
  }
);



// ============================================================
// NASARA ENGAGEMENT MANAGER
// Admin API + configurable daily reminders
// Ghana timezone: Africa/Accra
// ============================================================

const NASARA_ENGAGEMENT_SETTINGS =
  "nasara_engagement_settings";

const NASARA_ENGAGEMENT_CAMPAIGNS =
  "nasara_engagement_campaigns";

const NASARA_ENGAGEMENT_HISTORY =
  "nasara_daily_engagement_notifications";

const NASARA_ENGAGEMENT_TIMEZONE = "Africa/Accra";

// ------------------------------------------------------------
// Ghana date and time helpers
// ------------------------------------------------------------

function getNasaraGhanaDateTime() {
  const now = new Date();

  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: NASARA_ENGAGEMENT_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hourCycle: "h23",
  }).formatToParts(now);

  const values = {};

  for (const part of parts) {
    values[part.type] = part.value;
  }

  const weekdayMap = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };

  return {
    date: `${values.year}-${values.month}-${values.day}`,
    hour: Number(values.hour),
    minute: Number(values.minute),
    weekday: weekdayMap[values.weekday],
  };
}

// ------------------------------------------------------------
// Admin API: Get settings, campaigns and recent history
// ------------------------------------------------------------

app.get("/admin/engagement", async (req, res) => {
  try {
    const user = await authenticateNasaraAdminRequest(req, res);
    if (!user) return;

    const [
      settingsResult,
      campaignsResult,
      historyResult,
    ] = await Promise.all([
      supabaseAdmin
        .from(NASARA_ENGAGEMENT_SETTINGS)
        .select("*")
        .eq("id", 1)
        .maybeSingle(),

      supabaseAdmin
        .from(NASARA_ENGAGEMENT_CAMPAIGNS)
        .select("*")
        .order("weekday", { ascending: true }),

      supabaseAdmin
        .from(NASARA_ENGAGEMENT_HISTORY)
        .select("*")
        .order("notification_date", { ascending: false })
        .limit(30),
    ]);

    if (settingsResult.error) throw settingsResult.error;
    if (campaignsResult.error) throw campaignsResult.error;
    if (historyResult.error) throw historyResult.error;

    return res.json({
      success: true,
      settings: settingsResult.data,
      campaigns: campaignsResult.data || [],
      history: historyResult.data || [],
    });
  } catch (error) {
    console.error("Engagement dashboard error:", error);

    return res.status(500).json({
      success: false,
      message: "Could not load engagement manager.",
    });
  }
});

// ------------------------------------------------------------
// Admin API: Update global settings
// ------------------------------------------------------------

app.put("/admin/engagement/settings", async (req, res) => {
  try {
    const user = await authenticateNasaraAdminRequest(req, res);
    if (!user) return;

    const { enabled, send_hour, send_minute } = req.body;

    if (
      typeof enabled !== "boolean" ||
      !Number.isInteger(send_hour) ||
      send_hour < 0 ||
      send_hour > 23 ||
      !Number.isInteger(send_minute) ||
      send_minute < 0 ||
      send_minute > 59
    ) {
      return res.status(400).json({
        success: false,
        message: "Invalid engagement settings.",
      });
    }

    const { data, error } = await supabaseAdmin
      .from(NASARA_ENGAGEMENT_SETTINGS)
      .upsert({
        id: 1,
        enabled,
        send_hour,
        send_minute,
        updated_at: new Date().toISOString(),
        updated_by: user.id,
      })
      .select()
      .single();

    if (error) throw error;

    return res.json({
      success: true,
      settings: data,
    });
  } catch (error) {
    console.error("Update engagement settings error:", error);

    return res.status(500).json({
      success: false,
      message: "Could not update engagement settings.",
    });
  }
});

// ------------------------------------------------------------
// Admin API: Update a weekday campaign
// ------------------------------------------------------------

app.put(
  "/admin/engagement/campaigns/:weekday",
  async (req, res) => {
    try {
      const user = await authenticateNasaraAdminRequest(req, res);
      if (!user) return;

      const weekday = Number(req.params.weekday);
      const { feature_key, title, body, enabled } = req.body;

      if (
        !Number.isInteger(weekday) ||
        weekday < 0 ||
        weekday > 6 ||
        typeof feature_key !== "string" ||
        !feature_key.trim() ||
        typeof title !== "string" ||
        !title.trim() ||
        typeof body !== "string" ||
        !body.trim() ||
        typeof enabled !== "boolean"
      ) {
        return res.status(400).json({
          success: false,
          message: "Invalid campaign details.",
        });
      }

      const { data, error } = await supabaseAdmin
        .from(NASARA_ENGAGEMENT_CAMPAIGNS)
        .upsert({
          weekday,
          feature_key: feature_key.trim(),
          title: title.trim(),
          body: body.trim(),
          enabled,
          updated_at: new Date().toISOString(),
          updated_by: user.id,
        })
        .select()
        .single();

      if (error) throw error;

      return res.json({
        success: true,
        campaign: data,
      });
    } catch (error) {
      console.error("Update engagement campaign error:", error);

      return res.status(500).json({
        success: false,
        message: "Could not save campaign.",
      });
    }
  }
);

// ------------------------------------------------------------
// Admin API: Campaign history
// ------------------------------------------------------------

app.get("/admin/engagement/history", async (req, res) => {
  try {
    const user = await authenticateNasaraAdminRequest(req, res);
    if (!user) return;

    const { data, error } = await supabaseAdmin
      .from(NASARA_ENGAGEMENT_HISTORY)
      .select("*")
      .order("notification_date", { ascending: false })
      .limit(60);

    if (error) throw error;

    return res.json({
      success: true,
      history: data || [],
    });
  } catch (error) {
    console.error("Engagement history error:", error);

    return res.status(500).json({
      success: false,
      message: "Could not load campaign history.",
    });
  }
});
// ------------------------------------------------------------
// Send one native reminder to one user
// Browser push is handled once per campaign using broadcast.
// ------------------------------------------------------------

async function sendNasaraEngagementReminder(userId, campaign) {
  try {
    const result = await notifyUser(
      userId,
      campaign.title,
      campaign.body,
      {
        type: "daily_engagement",
        feature_key: campaign.feature_key,
        url: "/",
      }
    );

    const accepted = result?.success === true;

    if (!accepted) {
      console.error(
        "Engagement native notification not accepted:",
        userId,
        result
      );
    }

    return {
      success: accepted,
      userId,
      result,
    };
  } catch (error) {
    console.error(
      "Engagement native notification failed:",
      userId,
      error?.message || String(error)
    );

    return {
      success: false,
      userId,
      error: error?.message || String(error),
    };
  }
}
// ------------------------------------------------------------
// Admin API: Send a test reminder
// Native: logged-in admin only
// Browser: all registered browser subscriptions
// ------------------------------------------------------------

app.post("/admin/engagement/test", async (req, res) => {
  try {
    const admin = await authenticateNasaraAdminRequest(req, res);
    if (!admin) return;

    const title =
      typeof req.body?.title === "string" &&
      req.body.title.trim()
        ? req.body.title.trim()
        : "Nasara test notification";

    const body =
      typeof req.body?.body === "string" &&
      req.body.body.trim()
        ? req.body.body.trim()
        : "Your Nasara notifications are connected.";

    let nativeResult = null;
    let browserResult = null;

    let nativeError = null;
    let browserError = null;

    // --------------------------------------------------------
    // 1. SEND NATIVE NOTIFICATION TO THE LOGGED-IN ADMIN
    // --------------------------------------------------------

    try {
      nativeResult = await notifyUser(
        admin.id,
        title,
        body,
        {
          type: "daily_engagement",
          feature_key: "admin_test",
          url: "/",
        }
      );
    } catch (error) {
      nativeError = error?.message || String(error);

      console.error(
        "Engagement test native notification error:",
        error
      );
    }

    // --------------------------------------------------------
    // 2. SEND BROWSER NOTIFICATION
    // Uses the same broadcast mechanism as working
    // Nasara browser notifications.
    // --------------------------------------------------------

    try {
      browserResult = await broadcastBrowserPush(
        title,
        body,
        "/"
      );
    } catch (error) {
      browserError = error?.message || String(error);

      console.error(
        "Engagement test browser notification error:",
        error
      );
    }

    // --------------------------------------------------------
    // 3. CHECK RESULTS
    // --------------------------------------------------------

    const nativeAccepted =
      nativeResult?.success === true;

    const browserSent =
      Number(browserResult?.sent || 0);

    const browserAccepted =
      browserSent > 0;

    console.log("NASARA ENGAGEMENT TEST RESULTS:", {
      adminId: admin.id,
      nativeAccepted,
      browserAccepted,
      browserSent,
      browserFailed: Number(browserResult?.failed || 0),
      nativeError,
      browserError,
    });

    // --------------------------------------------------------
    // 4. NEITHER CHANNEL ACCEPTED THE NOTIFICATION
    // --------------------------------------------------------

    if (!nativeAccepted && !browserAccepted) {
      return res.status(502).json({
        success: false,
        message: "Neither notification channel confirmed acceptance.",
        native: false,
        browser: false,
        browserSent,
        details: {
          nativeError,
          browserError,
          browserResult,
        },
      });
    }

    // --------------------------------------------------------
    // 5. AT LEAST ONE CHANNEL ACCEPTED THE NOTIFICATION
    // --------------------------------------------------------

    return res.json({
      success: true,
      message: "Test notification processing completed.",
      channel:
        nativeAccepted && browserAccepted
          ? "native_and_browser"
          : nativeAccepted
            ? "native"
            : "browser",
      native: nativeAccepted,
      browser: browserAccepted,
      browserSent,
      browserFailed: Number(browserResult?.failed || 0),
    });

  } catch (error) {
    console.error("Engagement test error:", error);

    return res.status(500).json({
      success: false,
      message: "Could not send test notification.",
      details: error?.message || String(error),
    });
  }
});
// ------------------------------------------------------------
// Daily scheduler
// Native: individual users
// Browser: one broadcast to all registered subscriptions
// Ghana timezone: Africa/Accra
// ------------------------------------------------------------

let nasaraDailyEngagementRunning = false;

async function runNasaraDailyEngagementCampaign() {
  if (nasaraDailyEngagementRunning) {
    console.log("Nasara engagement reminder is already running.");
    return;
  }

  nasaraDailyEngagementRunning = true;

  let campaignDate = null;

  try {
    const ghanaTime = getNasaraGhanaDateTime();
    campaignDate = ghanaTime.date;

    const { data: settings, error: settingsError } =
      await supabaseAdmin
        .from(NASARA_ENGAGEMENT_SETTINGS)
        .select("*")
        .eq("id", 1)
        .maybeSingle();

    if (settingsError) throw settingsError;
    if (!settings || settings.enabled !== true) return;

    const currentMinutes =
      ghanaTime.hour * 60 + ghanaTime.minute;

    const scheduledMinutes =
      Number(settings.send_hour) * 60 +
      Number(settings.send_minute);

    if (currentMinutes < scheduledMinutes) return;

    const { data: campaign, error: campaignError } =
      await supabaseAdmin
        .from(NASARA_ENGAGEMENT_CAMPAIGNS)
        .select("*")
        .eq("weekday", ghanaTime.weekday)
        .eq("enabled", true)
        .maybeSingle();

    if (campaignError) throw campaignError;

    if (!campaign) {
      console.log(
        "Nasara engagement: no active campaign for weekday",
        ghanaTime.weekday
      );
      return;
    }

    // --------------------------------------------------------
    // 1. CHECK EXISTING DAILY HISTORY
    // --------------------------------------------------------

    const { data: existing, error: historyError } =
      await supabaseAdmin
        .from(NASARA_ENGAGEMENT_HISTORY)
        .select("*")
        .eq("notification_date", campaignDate)
        .maybeSingle();

    if (historyError) throw historyError;

    // --------------------------------------------------------
// STOP DUPLICATE DAILY NOTIFICATIONS
// A campaign can only run once per Ghana calendar date.
// This applies to sent, partial, failed and processing.
// --------------------------------------------------------

if (existing) {
  console.log(
    "Nasara engagement already attempted today:",
    {
      date: campaignDate,
      status: existing.status,
    }
  );

  return;
}

    // --------------------------------------------------------
    // 2. CREATE OR REOPEN TODAY'S CLAIM
    // --------------------------------------------------------

    if (existing) {
      const { error: reopenError } = await supabaseAdmin
        .from(NASARA_ENGAGEMENT_HISTORY)
        .update({
          status: "processing",
          feature_key: campaign.feature_key,
          title: campaign.title,
          body: campaign.body,
          started_at: new Date().toISOString(),
          completed_at: null,
        })
        .eq("notification_date", campaignDate);

      if (reopenError) throw reopenError;
    } else {
      const { error: claimError } = await supabaseAdmin
        .from(NASARA_ENGAGEMENT_HISTORY)
        .insert({
          notification_date: campaignDate,
          feature_key: campaign.feature_key,
          title: campaign.title,
          body: campaign.body,
          status: "processing",
          target_count: 0,
          sent_count: 0,
          failed_count: 0,
          started_at: new Date().toISOString(),
        });

      if (claimError) throw claimError;
    }

    console.log("NASARA DAILY ENGAGEMENT STARTED:", {
      date: campaignDate,
      feature: campaign.feature_key,
    });

    // --------------------------------------------------------
    // 3. GET ELIGIBLE NATIVE USERS
    // --------------------------------------------------------

    const { data: users, error: usersError } =
      await supabaseAdmin
        .from("profiles")
        .select("id")
        .eq("notifications_enabled", true)
        .eq("is_banned", false);

    if (usersError) throw usersError;

    const targetUsers = users || [];

    // --------------------------------------------------------
    // 4. BROWSER PUSH — ONE BROADCAST
    // --------------------------------------------------------

    let browserResult = null;
    let browserError = null;

    try {
      browserResult = await broadcastBrowserPush(
        campaign.title,
        campaign.body,
        "/"
      );

      console.log(
        "NASARA ENGAGEMENT BROWSER RESULT:",
        browserResult
      );
    } catch (error) {
      browserError = error?.message || String(error);

      console.error(
        "NASARA ENGAGEMENT BROWSER ERROR:",
        browserError
      );
    }

    const browserSent = Number(browserResult?.sent || 0);
    const browserFailed = Number(browserResult?.failed || 0);

    // --------------------------------------------------------
    // 5. NATIVE PUSH — INDIVIDUAL USERS
    // --------------------------------------------------------

    let nativeSent = 0;
    let nativeFailed = 0;

    const batchSize = 25;

    for (
      let start = 0;
      start < targetUsers.length;
      start += batchSize
    ) {
      const batch = targetUsers.slice(
        start,
        start + batchSize
      );

      const results = await Promise.all(
        batch.map((user) =>
          sendNasaraEngagementReminder(
            user.id,
            campaign
          )
        )
      );

      for (const result of results) {
        if (result?.success === true) {
          nativeSent += 1;
        } else {
          nativeFailed += 1;
        }
      }

      console.log("NASARA ENGAGEMENT NATIVE BATCH:", {
        processed: Math.min(
          start + batch.length,
          targetUsers.length
        ),
        total: targetUsers.length,
        accepted: nativeSent,
        failed: nativeFailed,
      });
    }

    // --------------------------------------------------------
    // 6. DETERMINE STATUS
    // --------------------------------------------------------

    const browserAccepted = browserSent > 0;

    const anyAccepted =
      nativeSent > 0 || browserAccepted;

    const hasFailures =
      nativeFailed > 0 ||
      browserFailed > 0 ||
      !!browserError;

    let status = "failed";

    if (anyAccepted && !hasFailures) {
      status = "sent";
    } else if (anyAccepted) {
      status = "partial";
    }

    // --------------------------------------------------------
    // 7. SAVE HISTORY
    // --------------------------------------------------------

    const { error: updateError } = await supabaseAdmin
      .from(NASARA_ENGAGEMENT_HISTORY)
      .update({
        status,
        target_count: targetUsers.length,
        sent_count: nativeSent,
        failed_count: nativeFailed,
        completed_at: new Date().toISOString(),
      })
      .eq("notification_date", campaignDate);

    if (updateError) throw updateError;

    console.log("NASARA DAILY ENGAGEMENT COMPLETED:", {
      date: campaignDate,
      feature: campaign.feature_key,
      native: {
        target: targetUsers.length,
        accepted: nativeSent,
        failed: nativeFailed,
      },
      browser: {
        accepted: browserSent,
        failed: browserFailed,
        error: browserError,
      },
      status,
    });

  } catch (error) {
    console.error(
      "Nasara daily engagement scheduler error:",
      error
    );

    // Mark an interrupted campaign as failed so it can be retried.
    if (campaignDate) {
      try {
        await supabaseAdmin
          .from(NASARA_ENGAGEMENT_HISTORY)
          .update({
            status: "failed",
            completed_at: new Date().toISOString(),
          })
          .eq("notification_date", campaignDate)
          .eq("status", "processing");
      } catch (historyError) {
        console.error(
          "Could not update engagement failure history:",
          historyError
        );
      }
    }
  } finally {
    nasaraDailyEngagementRunning = false;
  }
}
// ------------------------------------------------------------
// Register scheduler
// node-cron is already used by the existing backend.
// Do not remove or change the Friday Market scheduler.
// ------------------------------------------------------------

cron.schedule(
  "* * * * *",
  runNasaraDailyEngagementCampaign,
  {
    timezone: NASARA_ENGAGEMENT_TIMEZONE,
  }
);

console.log(
  "Nasara Engagement Manager scheduler registered."
);
// ============================================================
// 🟢 START SERVER
// ============================================================

const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", () => {
  console.log("Server running on port " + PORT);

  console.log(
    "🛍️ Friday Market reminder scheduled for Fridays at 9:00 AM Ghana time."
  );

  // Catch up if Render starts after 9:00 AM on Friday.
  sendFridayMarketReminder().catch((error) => {
    console.error(
      "🔴 Friday Market startup check failed:",
      error
    );
  });
  // Catch up Engagement Manager if Render starts late.
runNasaraDailyEngagementCampaign().catch((error) => {
  console.error(
    "Nasara Engagement startup check failed:",
    error
  );
});
});