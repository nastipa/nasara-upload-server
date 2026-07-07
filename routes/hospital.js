const express = require("express");
const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");
const notifyUser = require("../services/notifyUser");
const fetch = require("node-fetch");
const router = express.Router();


const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);
/* =========================================================
   AUTH MIDDLEWARE
========================================================= */

async function authenticate(req, res, next) {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader) {
      return res.status(401).json({
        success: false,
        error: "Missing Authorization header",
      });
    }

    const token = authHeader.replace("Bearer ", "");

    const { data, error } =
      await supabaseAdmin.auth.getUser(token);

    if (error || !data?.user) {
      return res.status(401).json({
        success: false,
        error: "Invalid access token",
      });
    }

    req.user = data.user;

    next();

  } catch (err) {
    return res.status(500).json({
      success: false,
      error: err.message,
    });
  }
}
/* =========================================================
   HOSPITAL ADMIN AUTH
========================================================= */

async function hospitalAdminAuth(
  req,
  res,
  next
) {
  try {
    const userId = req.user.id;

    const { data, error } =
      await supabaseAdmin
        .from("hospital_admins")
        .select("*")
        .eq("user_id", userId)
        .eq("status", "approved")
        .maybeSingle();

    if (error) {
      return res.status(400).json({
        success: false,
        error: error.message,
      });
    }

    if (!data) {
      return res.status(403).json({
        success: false,
        error:
          "You are not an approved hospital administrator.",
      });
    }

    req.hospitalAdmin = data;

    next();

  } catch (err) {
    return res.status(500).json({
      success: false,
      error: err.message,
    });
  }
}
/* =========================================================
   GET ALL ACTIVE HOSPITALS
========================================================= */

router.get("/list", async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from("hospitals")
      .select("*")
      .eq("is_active", true)
      .order("name");

    if (error) {
      return res.status(400).json({
        success: false,
        error: error.message,
      });
    }

    return res.json({
      success: true,
      hospitals: data,
    });
  } catch (err) {
    console.log(err);

    return res.status(500).json({
      success: false,
      error: err.message,
    });
  }
});




/* =========================================================
   JOIN HOSPITAL QUEUE
========================================================= */

router.post("/join-queue", authenticate, async (req, res) => {
  try {
   const {
  hospital_id,
  department_id,
  condition,
} = req.body;

const patient_id = req.user.id;

    if (
      !hospital_id ||
      !patient_id ||
      !department_id
    ) {
      return res.status(400).json({
        success: false,
        error: "Missing required fields",
      });
    }

    // Today's date
    const bookingDate = new Date()
      .toISOString()
      .split("T")[0];

    // Department
    const { data: department, error: depError } =
      await supabaseAdmin
        .from("hospital_departments")
        .select("*")
        .eq("id", department_id)
        .single();

    if (depError || !department) {
      return res.status(400).json({
        success: false,
        error: "Department not found",
      });
    }

    // Count today's bookings for this department
    const { count } = await supabaseAdmin
      .from("hospital_bookings")
      .select("*", {
        count: "exact",
        head: true,
      })
      .eq("hospital_id", hospital_id)
      .eq("department_id", department_id)
      .eq("booking_date", bookingDate);

    const queuePosition = (count || 0) + 1;

    // Queue prefix
    const prefix =
      department.name
        .substring(0, 3)
        .toUpperCase();

    const queueNumber =
      `${prefix}-${String(queuePosition).padStart(3, "0")}`;

    // Secure booking code
const bookingCode =
  "NHS-" +
  crypto
    .randomBytes(3)
    .toString("hex")
    .toUpperCase();
    // Estimated wait
    const estimatedWait =
      queuePosition *
      (department.average_minutes || 10);

    // Insert booking
    const { data, error } =
      await supabaseAdmin
        .from("hospital_bookings")
        .insert({
          hospital_id,
          patient_id,
          department_id,
          booking_date: bookingDate,
          condition,
          queue_number: queueNumber,
          booking_code: bookingCode,
          qr_code: bookingCode,
          estimated_wait_minutes:
            estimatedWait,
          status: "waiting",
        })
        .select()
        .single();

    if (error) {
      return res.status(400).json({
        success: false,
        error: error.message,
      });
    }

    return res.json({
      success: true,
      booking: data,
    });

  } catch (err) {
    console.log(err);

    return res.status(500).json({
      success: false,
      error: err.message,
    });
  }
});
/* =========================================================
   GET MY ACTIVE QUEUE
========================================================= */

router.get("/my-queue", authenticate, async (req, res) => {
  try {
    const patientId = req.user.id;
    const today = new Date()
      .toISOString()
      .split("T")[0];

    const { data, error } = await supabaseAdmin
      .from("hospital_bookings")
      .select(`
        *,
        hospitals(
          id,
          name,
          town,
          region,
          phone
        ),
        hospital_departments(
          id,
          name
        )
      `)
      .eq("patient_id", patientId)
      .eq("booking_date", today)
      .neq("status", "completed")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      return res.status(400).json({
        success: false,
        error: error.message,
      });
    }

    if (!data) {
      return res.json({
        success: true,
        booking: null,
      });
    }

    return res.json({
      success: true,
      booking: data,
    });

  } catch (err) {
    console.log(err);

    return res.status(500).json({
      success: false,
      error: err.message,
    });
  }
});
/* =========================================================
   HOSPITAL DASHBOARD
========================================================= */

router.get(
  "/dashboard",
  authenticate,
  hospitalAdminAuth,
  async (req, res) => {
  try {
   const hospitalId =
  req.hospitalAdmin.hospital_id;
    const today = new Date()
      .toISOString()
      .split("T")[0];

    const { count: waiting } = await supabaseAdmin
      .from("hospital_bookings")
      .select("*", { count: "exact", head: true })
      .eq("hospital_id", hospitalId)
      .eq("booking_date", today)
      .eq("status", "waiting");

    const { count: called } = await supabaseAdmin
      .from("hospital_bookings")
      .select("*", { count: "exact", head: true })
      .eq("hospital_id", hospitalId)
      .eq("booking_date", today)
      .eq("status", "called");

    const { count: checkedIn } = await supabaseAdmin
      .from("hospital_bookings")
      .select("*", { count: "exact", head: true })
      .eq("hospital_id", hospitalId)
      .eq("booking_date", today)
      .eq("status", "checked_in");

    const { count: completed } = await supabaseAdmin
      .from("hospital_bookings")
      .select("*", { count: "exact", head: true })
      .eq("hospital_id", hospitalId)
      .eq("booking_date", today)
      .eq("status", "completed");

    const { count: total } = await supabaseAdmin
      .from("hospital_bookings")
      .select("*", { count: "exact", head: true })
      .eq("hospital_id", hospitalId)
      .eq("booking_date", today);

    return res.json({
      success: true,
      dashboard: {
        waiting: waiting || 0,
        called: called || 0,
        checked_in: checkedIn || 0,
        completed: completed || 0,
        total: total || 0,
      },
    });

  } catch (err) {
    console.log(err);

    return res.status(500).json({
      success: false,
      error: err.message,
    });
  }
});
/* =========================================================
   TODAY'S HOSPITAL QUEUE
========================================================= */

router.get(
  "/queue",
  authenticate,
  hospitalAdminAuth,
  async (req, res) => {
  try {
    const hospitalId =
  req.hospitalAdmin.hospital_id;

    const today = new Date()
      .toISOString()
      .split("T")[0];

    const { data, error } = await supabaseAdmin
      .from("hospital_bookings")
      .select(`
        *,
        hospital_departments(
          id,
          name
        )
      `)
      .eq("hospital_id", hospitalId)
      .eq("booking_date", today)
      .order("created_at", {
        ascending: true,
      });

    if (error) {
      return res.status(400).json({
        success: false,
        error: error.message,
      });
    }

    return res.json({
      success: true,
      queue: data || [],
    });

  } catch (err) {
    console.log(err);

    return res.status(500).json({
      success: false,
      error: err.message,
    });
  }
});
/* =========================================================
   CREATE HOSPITAL DEPARTMENT
========================================================= */

router.post(
  "/create-department",
  authenticate,
  hospitalAdminAuth,
  async (req, res) => {
    try {
      const hospitalId = req.hospitalAdmin.hospital_id;

      const {
        name,
        average_minutes,
      } = req.body;

      if (!name) {
        return res.status(400).json({
          success: false,
          error: "Department name is required",
        });
      }

      const { data: existing } =
        await supabaseAdmin
          .from("hospital_departments")
          .select("id")
          .eq("hospital_id", hospitalId)
          .ilike("name", name)
          .maybeSingle();

      if (existing) {
        return res.status(400).json({
          success: false,
          error: "Department already exists.",
        });
      }

      const { data, error } =
        await supabaseAdmin
          .from("hospital_departments")
          .insert({
            hospital_id: hospitalId,
            name: name.trim(),
            average_minutes:
              average_minutes || 10,
            is_active: true,
          })
          .select()
          .single();

      if (error) {
        return res.status(400).json({
          success: false,
          error: error.message,
        });
      }

      return res.json({
        success: true,
        department: data,
      });

    } catch (err) {
      console.log(err);

      return res.status(500).json({
        success: false,
        error: err.message,
      });
    }
  }
);
/* =========================================================
   GET HOSPITAL DEPARTMENTS
========================================================= */

router.get(
  "/departments",
  authenticate,
  hospitalAdminAuth,
  async (req, res) => {
    try {
      const hospitalId =
        req.hospitalAdmin.hospital_id;

      const { data, error } =
        await supabaseAdmin
          .from("hospital_departments")
          .select("*")
          .eq("hospital_id", hospitalId)
          .order("name");

      if (error) {
        return res.status(400).json({
          success: false,
          error: error.message,
        });
      }

      return res.json({
        success: true,
        departments: data || [],
      });

    } catch (err) {
      console.log(err);

      return res.status(500).json({
        success: false,
        error: err.message,
      });
    }
  }
);
/* =========================================================
   UPDATE HOSPITAL DEPARTMENT
========================================================= */

router.put(
  "/update-department",
  authenticate,
  hospitalAdminAuth,
  async (req, res) => {
    try {
      const hospitalId =
        req.hospitalAdmin.hospital_id;

      const {
        department_id,
        name,
        average_minutes,
        is_active,
      } = req.body;

      if (!department_id) {
        return res.status(400).json({
          success: false,
          error: "department_id is required",
        });
      }

      const { data: department } =
        await supabaseAdmin
          .from("hospital_departments")
          .select("*")
          .eq("id", department_id)
          .eq("hospital_id", hospitalId)
          .maybeSingle();

      if (!department) {
        return res.status(404).json({
          success: false,
          error: "Department not found.",
        });
      }

      const updates = {};

      if (name !== undefined)
        updates.name = name.trim();

      if (average_minutes !== undefined)
        updates.average_minutes =
          average_minutes;

      if (is_active !== undefined)
        updates.is_active = is_active;

      const { data, error } =
        await supabaseAdmin
          .from("hospital_departments")
          .update(updates)
          .eq("id", department_id)
          .select()
          .single();

      if (error) {
        return res.status(400).json({
          success: false,
          error: error.message,
        });
      }

      return res.json({
        success: true,
        department: data,
      });

    } catch (err) {
      console.log(err);

      return res.status(500).json({
        success: false,
        error: err.message,
      });
    }
  }
);
/* =========================================================
   DELETE HOSPITAL DEPARTMENT
========================================================= */

router.delete(
  "/delete-department/:id",
  authenticate,
  hospitalAdminAuth,
  async (req, res) => {
    try {
      const hospitalId =
        req.hospitalAdmin.hospital_id;

      const { id } = req.params;

      const { data: department } =
        await supabaseAdmin
          .from("hospital_departments")
          .select("*")
          .eq("id", id)
          .eq("hospital_id", hospitalId)
          .maybeSingle();

      if (!department) {
        return res.status(404).json({
          success: false,
          error: "Department not found.",
        });
      }

      const { data, error } =
        await supabaseAdmin
          .from("hospital_departments")
          .update({
            is_active: false,
          })
          .eq("id", id)
          .select()
          .single();

      if (error) {
        return res.status(400).json({
          success: false,
          error: error.message,
        });
      }

      return res.json({
        success: true,
        message: "Department deleted successfully.",
        department: data,
      });

    } catch (err) {
      console.log(err);

      return res.status(500).json({
        success: false,
        error: err.message,
      });
    }
  }
);
/* =========================================================
   CREATE DEFAULT HOSPITAL DEPARTMENTS
========================================================= */

router.post(
  "/create-default-departments",
  authenticate,
  hospitalAdminAuth,
  async (req, res) => {
    try {
      const hospitalId =
        req.hospitalAdmin.hospital_id;

      const defaultDepartments = [
        { name: "OPD", average_minutes: 10 },
        { name: "Emergency", average_minutes: 5 },
        { name: "Maternity", average_minutes: 20 },
        { name: "Pediatrics", average_minutes: 15 },
        { name: "Laboratory", average_minutes: 10 },
        { name: "Pharmacy", average_minutes: 5 },
        { name: "Dental", average_minutes: 20 },
        { name: "Eye Clinic", average_minutes: 15 },
        { name: "ENT", average_minutes: 15 },
        { name: "Physiotherapy", average_minutes: 25 },
        { name: "Surgical", average_minutes: 30 },
        { name: "Radiology", average_minutes: 15 },
        { name: "Dialysis", average_minutes: 45 },
        { name: "Mental Health", average_minutes: 30 },
        { name: "Family Planning", average_minutes: 15 },
      ];

      const { data: existing } =
        await supabaseAdmin
          .from("hospital_departments")
          .select("name")
          .eq("hospital_id", hospitalId);

      const existingNames = new Set(
        (existing || []).map(d =>
          d.name.toLowerCase()
        )
      );

      const departmentsToInsert =
        defaultDepartments
          .filter(
            d =>
              !existingNames.has(
                d.name.toLowerCase()
              )
          )
          .map(d => ({
            hospital_id: hospitalId,
            name: d.name,
            average_minutes:
              d.average_minutes,
            is_active: true,
          }));

      if (
        departmentsToInsert.length === 0
      ) {
        return res.json({
          success: true,
          message:
            "All default departments already exist.",
          departments: [],
        });
      }

      const { data, error } =
        await supabaseAdmin
          .from("hospital_departments")
          .insert(departmentsToInsert)
          .select();

      if (error) {
        return res.status(400).json({
          success: false,
          error: error.message,
        });
      }

      return res.json({
        success: true,
        message:
          "Default departments created successfully.",
        departments: data,
      });

    } catch (err) {
      console.log(err);

      return res.status(500).json({
        success: false,
        error: err.message,
      });
    }
  }
);
/* =========================================================
   GET SINGLE HOSPITAL
========================================================= */

router.get("/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const { data: hospital, error } = await supabaseAdmin
      .from("hospitals")
      .select("*")
      .eq("id", id)
      .single();

    if (error) {
      return res.status(404).json({
        success: false,
        error: error.message,
      });
    }

    const { data: departments } = await supabaseAdmin
      .from("hospital_departments")
      .select("*")
      .eq("hospital_id", id)
      .eq("is_active", true)
      .order("name");

    return res.json({
      success: true,
      hospital,
      departments: departments || [],
    });
  } catch (err) {
    console.log(err);

    return res.status(500).json({
      success: false,
      error: err.message,
    });
  }
});


/* =========================================================
   UPDATE BOOKING STATUS
========================================================= */

router.post(
"/update-booking-status",
authenticate,
hospitalAdminAuth, async (req, res) => {
  try {
    const { booking_id, status } = req.body;
    const hospitalId = req.hospitalAdmin.hospital_id;
    if (!booking_id || !status) {
      return res.status(400).json({
        success: false,
        error: "booking_id and status are required",
      });
    }

    const allowedStatuses = [
      "waiting",
      "called",
      "checked_in",
      "completed",
      "cancelled",
      "no_show",
    ];

    if (!allowedStatuses.includes(status)) {
      return res.status(400).json({
        success: false,
        error: "Invalid status",
      });
    }

    const updates = {
      status,
    };

    if (status === "called") {
      updates.called_at = new Date().toISOString();
    }

    if (status === "checked_in") {
      updates.checked_in = true;
    }

    if (status === "completed") {
      updates.completed_at = new Date().toISOString();
    }

    // Verify booking belongs to this hospital
const { data: booking, error: bookingError } =
  await supabaseAdmin
    .from("hospital_bookings")
    .select("*")
    .eq("id", booking_id)
    .eq("hospital_id", hospitalId)
    .maybeSingle();

if (bookingError) {
  return res.status(400).json({
    success: false,
    error: bookingError.message,
  });
}

if (!booking) {
  return res.status(404).json({
    success: false,
    error: "Booking not found for your hospital.",
  });
}

const { data, error } =
  await supabaseAdmin
    .from("hospital_bookings")
    .update(updates)
    .eq("id", booking_id)
    .select()
    .single();

    if (error) {
      return res.status(400).json({
        success: false,
        error: error.message,
      });
    }

    // Notify patient
    if (data?.patient_id) {
      let title = "Hospital Update";
      let body = "Your booking has been updated.";

      switch (status) {
        case "called":
          title = "It's Your Turn";
          body =
            "Please proceed to the consultation room.";
          break;

        case "checked_in":
          title = "Checked In";
          body =
            "You have successfully checked in.";
          break;

        case "completed":
          title = "Visit Completed";
          body =
            "Thank you for visiting. We wish you good health.";
          break;

        case "cancelled":
          title = "Booking Cancelled";
          body =
            "Your hospital booking has been cancelled.";
          break;

        case "no_show":
          title = "Missed Appointment";
          body =
            "Your booking has been marked as no show.";
          break;
      }

      await notifyUser(
        data.patient_id,
        title,
        body
      );
    }

    return res.json({
      success: true,
      booking: data,
    });

  } catch (err) {
    console.log(err);

    return res.status(500).json({
      success: false,
      error: err.message,
    });
  }
});
/* =========================================================
   CHECK IN USING QR OR BOOKING CODE
========================================================= */

router.post(
"/checkin",
authenticate,
hospitalAdminAuth, async (req, res) => {
  try {
    const { booking_code } = req.body;
    const hospitalId =
  req.hospitalAdmin.hospital_id;
    if (!booking_code) {
      return res.status(400).json({
        success: false,
        error: "booking_code is required",
      });
    }

    const { data: booking, error } =
  await supabaseAdmin
    .from("hospital_bookings")
    .select("*")
    .eq("booking_code", booking_code)
    .eq("hospital_id", hospitalId)
    .maybeSingle();

    if (error) {
      return res.status(400).json({
        success: false,
        error: error.message,
      });
    }

    if (!booking) {
      return res.status(404).json({
        success: false,
        error: "Booking not found",
      });
    }

    if (booking.checked_in) {
      return res.status(400).json({
        success: false,
        error: "Patient has already checked in",
      });
    }

    const { data, error: updateError } = await supabaseAdmin
      .from("hospital_bookings")
      .update({
        checked_in: true,
        status: "checked_in",
      })
      .eq("id", booking.id)
      .select()
      .single();

    if (updateError) {
      return res.status(400).json({
        success: false,
        error: updateError.message,
      });
    }

    await notifyUser(
      booking.patient_id,
      "Checked In",
      "You have successfully checked in. Please wait to be called."
    );

    return res.json({
      success: true,
      booking: data,
    });

  } catch (err) {
    console.log(err);

    return res.status(500).json({
      success: false,
      error: err.message,
    });
  }
});

module.exports = router;