const express = require("express");
const multer = require("multer");
const cors = require("cors");
const AWS = require("aws-sdk");
const PDFDocument = require("pdfkit");
require("dotenv").config();
const hospitalRoutes = require("./routes/hospital");
const restaurantRoutes = require("./routes/restaurant");

const { createClient } = require("@supabase/supabase-js");
const AdmZip = require("adm-zip");
const notifyUser = require("./services/notifyUser");

const app = express();
app.use(cors());
app.use(
  express.json({
    limit: "50mb",
  })
);

/* ================= LIMIT FILE SIZE (20MB) ================= */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
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
/* ================= SECURE DELETE ACCOUNT ================= */
app.post("/delete-account", async (req, res) => {
  try {
    const token = req.headers.authorization?.replace("Bearer ", "");

    if (!token) {
      return res.status(401).json({
        error: "No token provided",
      });
    }

    const { data, error } =
      await supabaseAdmin.auth.getUser(token);

    if (error || !data?.user) {
      return res.status(401).json({
        error: "Invalid token",
      });
    }

    const userId = data.user.id;

    // Clean up everything owned by the user
    const { error: rpcError } =
      await supabaseAdmin.rpc(
        "delete_user_everything",
        {
          p_user_id: userId,
        }
      );

    if (rpcError) {
      return res.status(500).json({
        error: rpcError.message,
      });
    }

    // Delete Auth user last
    const { error: authError } =
      await supabaseAdmin.auth.admin.deleteUser(userId);

    if (authError) {
      return res.status(500).json({
        error: authError.message,
      });
    }

    return res.json({
      success: true,
    });

  } catch (err) {
    console.log(err);

    return res.status(500).json({
      error: err.message,
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

/* ================= PUSH ROUTE ================= */
app.post("/send-push", async (req, res) => {
  try {
    const { title, body, type, ref_id } = req.body;

    const { data: users } = await supabaseAdmin
      .from("profiles")
      .select("push_token");

    const tokens = users
      ?.map((u) => u.push_token)
      .filter(Boolean);

    if (!tokens || tokens.length === 0) {
      return res.json({ success: true });
    }

    // 🔥 use helper
   await sendPush(
  tokens,
  title,
  body,
  {
    type,
    ref_id,
  }
);

    res.json({ success: true });
  } catch (err) {
    console.log(err);
    res.status(500).json({ error: "Push failed" });
  }
});
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
    console.log("Creating Netlify ZIP using ADM-ZIP...");

    const zip = new AdmZip();

    zip.addFile(
      "index.html",
      Buffer.from(html, "utf8")
    );

    const zipBuffer = zip.toBuffer();

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
/* ================= HEALTH CHECK (OPTIONAL BUT USEFUL) ================= */
app.get("/", (req, res) => {
  res.send("Nasara upload server running 🚀");
});

/* ================= START SERVER ================= */
const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", () => {
  console.log("Server running on port " + PORT);
});