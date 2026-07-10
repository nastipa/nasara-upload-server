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
   NOTIFY NEXT PATIENTS
========================================================= */

async function notifyNextPatients(
  hospitalId,
  departmentId,
  bookingDate
) {
  try {

   const { data: waitingPatients, error } =
      await supabaseAdmin
        .from("hospital_bookings")
        .select(`
          id,
          patient_id,
          queue_number,
          almost_notified
        `)
        .eq("hospital_id", hospitalId)
        .eq("department_id", departmentId)
        .eq("booking_date", bookingDate)
        .eq("status", "waiting")
        .order("created_at", {
          ascending: true,
        })
        .limit(3);

    if (error || !waitingPatients) {
      return;
    }

    for (let i = 0; i < waitingPatients.length; i++) {

      const patient =
        waitingPatients[i];

      let title = "";
      let body = "";

      if (i === 0) {

        title = "You're Next";

        body =
          `Your queue number ${patient.queue_number} is next. Please proceed to your department.`;

      } else {

        title = "Almost Your Turn";

        body =
          `Your queue number ${patient.queue_number} is approaching. Please remain nearby.`;

      }

      if (!patient.almost_notified) {

  notifyUser(
    patient.patient_id,
    title,
    body
  ).catch(err =>
    console.log(
      "Notification error:",
      err.message
    )
  );
  await supabaseAdmin
  .from("hospital_notifications")
  .insert({
    hospital_id: hospitalId,
    patient_id: patient.patient_id,
    booking_id: patient.id,
    title,
    message: body,
  });


  await supabaseAdmin
    .from("hospital_bookings")
    .update({
      almost_notified: true,
    })
    .eq("id", patient.id);

}

    }

  } catch (err) {

    console.log(
      "notifyNextPatients:",
      err.message
    );

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
   GET LIVE QUEUE PROGRESS
========================================================= */

router.get(
  "/queue-progress",
  authenticate,
  async (req, res) => {
    try {

      const patientId = req.user.id;

      const today = new Date()
        .toISOString()
        .split("T")[0];

      // Patient's active booking
      const { data: booking, error: bookingError } =
        await supabaseAdmin
          .from("hospital_bookings")
          .select(`
            *,
            hospital_departments(
              id,
              name
            )
          `)
          .eq("patient_id", patientId)
          .eq("booking_date", today)
          .neq("status", "completed")
          .maybeSingle();

      if (bookingError) {
        return res.status(400).json({
          success: false,
          error: bookingError.message,
        });
      }

      if (!booking) {
        return res.json({
          success: true,
          progress: null,
        });
      }

      // Current serving
      const { data: currentServing } =
        await supabaseAdmin
          .from("hospital_bookings")
          .select("queue_number")
          .eq("hospital_id", booking.hospital_id)
          .eq("department_id", booking.department_id)
          .eq("booking_date", today)
          .eq("status", "called")
          .order("created_at", {
            ascending: false,
          })
          .limit(1)
          .maybeSingle();

      // People ahead
      const { count: peopleAhead } =
        await supabaseAdmin
          .from("hospital_bookings")
          .select("*", {
            count: "exact",
            head: true,
          })
          .eq("hospital_id", booking.hospital_id)
          .eq("department_id", booking.department_id)
          .eq("booking_date", today)
          .in("status", [
            "waiting",
            "checked_in",
          ])
          .lt("created_at", booking.created_at);

      const ahead = peopleAhead || 0;

// Total patients for this department today
const { count: totalPatients } =
  await supabaseAdmin
    .from("hospital_bookings")
    .select("*", {
      count: "exact",
      head: true,
    })
    .eq("hospital_id", booking.hospital_id)
    .eq("department_id", booking.department_id)
    .eq("booking_date", today);

const total = totalPatients || 1;

const estimatedWait =
  ahead *
  (
    booking.hospital_departments
      ?.average_minutes || 10
  );

// Percentage through the queue
const progress =
  Math.round(
    ((total - ahead) / total) * 100
  );

      return res.json({
        success: true,
        progress: {
          current_serving:
            currentServing?.queue_number || null,

          your_number:
            booking.queue_number,

          people_ahead:
            ahead,

          estimated_wait_minutes:
            estimatedWait,

          progress_percent:
            progress,

          status:
            booking.status,
        },
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
   GET LIVE QUEUE BOARD
========================================================= */

router.get(
  "/live-queue",
  authenticate,
  async (req, res) => {
    try {

      const patientId = req.user.id;

      const today = new Date()
        .toISOString()
        .split("T")[0];

      // Find patient's active booking
      const { data: booking, error: bookingError } =
        await supabaseAdmin
          .from("hospital_bookings")
          .select("*")
          .eq("patient_id", patientId)
          .eq("booking_date", today)
          .neq("status", "completed")
          .maybeSingle();

      if (bookingError) {
        return res.status(400).json({
          success: false,
          error: bookingError.message,
        });
      }

      if (!booking) {
        return res.json({
          success: true,
          queue: null,
        });
      }

      // Current serving
      const { data: currentServing } =
        await supabaseAdmin
          .from("hospital_bookings")
          .select("queue_number")
          .eq("hospital_id", booking.hospital_id)
          .eq("department_id", booking.department_id)
          .eq("booking_date", today)
          .eq("status", "called")
          .order("created_at", {
            ascending: false,
          })
          .limit(1)
          .maybeSingle();

      // Next patients waiting
      const { data: nextPatients } =
        await supabaseAdmin
          .from("hospital_bookings")
          .select("queue_number")
          .eq("hospital_id", booking.hospital_id)
          .eq("department_id", booking.department_id)
          .eq("booking_date", today)
          .in("status", [
            "waiting",
            "checked_in",
          ])
          .order("created_at", {
            ascending: true,
          })
          .limit(5);

      // Waiting count
      const { count: waitingCount } =
        await supabaseAdmin
          .from("hospital_bookings")
          .select("*", {
            count: "exact",
            head: true,
          })
          .eq("hospital_id", booking.hospital_id)
          .eq("department_id", booking.department_id)
          .eq("booking_date", today)
          .in("status", [
            "waiting",
            "checked_in",
          ]);

      return res.json({
        success: true,
        queue: {

          current_serving:
            currentServing?.queue_number || null,

          next_numbers:
            (nextPatients || []).map(
              item => item.queue_number
            ),

          total_waiting:
            waitingCount || 0,

          your_number:
            booking.queue_number,

          your_status:
            booking.status,

        },
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
 hospitals (
   id,
   name,
   city,
   district,
   region,
   phone,
   address
 ),
 hospital_departments (
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
   GET PATIENT VISIT HISTORY
========================================================= */

router.get(
  "/visit-history",
  authenticate,
  async (req, res) => {
    try {
      const patientId = req.user.id;

      const { data, error } =
        await supabaseAdmin
          .from("hospital_bookings")
          .select(`
            *,
            hospitals(
              id,
              name,
              city,
              district,
              region
            ),
            hospital_departments(
              id,
              name
            )
          `)
          .eq("patient_id", patientId)
          .order("booking_date", {
            ascending: false,
          })
          .order("created_at", {
            ascending: false,
          });

      if (error) {
        return res.status(400).json({
          success: false,
          error: error.message,
        });
      }

      return res.json({
        success: true,
        visits: data || [],
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
   CANCEL HOSPITAL BOOKING
========================================================= */

router.post(
  "/cancel-booking",
  authenticate,
  async (req, res) => {
    try {

      const { booking_id } = req.body;
      const patientId = req.user.id;

      if (!booking_id) {
        return res.status(400).json({
          success: false,
          error: "booking_id is required",
        });
      }

      // Verify booking belongs to patient
      const { data: booking, error: bookingError } =
        await supabaseAdmin
          .from("hospital_bookings")
          .select("*")
          .eq("id", booking_id)
          .eq("patient_id", patientId)
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
          error: "Booking not found."
        });
      }

      if (
        booking.status === "completed" ||
        booking.status === "cancelled"
      ) {
        return res.status(400).json({
          success: false,
          error: "This booking cannot be cancelled."
        });
      }

      const { data, error } =
        await supabaseAdmin
          .from("hospital_bookings")
          .update({
            status: "cancelled",
            cancelled_at: new Date().toISOString(),
          })
          .eq("id", booking_id)
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
        message: "Booking cancelled successfully.",
        booking: data,
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
   HOSPITAL ANALYTICS
========================================================= */

router.get(
  "/analytics",
  authenticate,
  hospitalAdminAuth,
  async (req, res) => {
    try {

      const hospitalId =
        req.hospitalAdmin.hospital_id;

      const today = new Date()
        .toISOString()
        .split("T")[0];

      const { data: bookings, error } =
        await supabaseAdmin
          .from("hospital_bookings")
          .select(`
            id,
            status,
            created_at,
            called_at,
            completed_at,
            department_id,
            hospital_departments(
              name
            )
          `)
          .eq("hospital_id", hospitalId)
          .eq("booking_date", today);

      if (error) {
        return res.status(400).json({
          success: false,
          error: error.message,
        });
      }

      const list = bookings || [];

      const totalPatients = list.length;

      const completed =
        list.filter(
          b => b.status === "completed"
        ).length;

      const waiting =
        list.filter(
          b => b.status === "waiting"
        ).length;

      const called =
        list.filter(
          b => b.status === "called"
        ).length;

      const checkedIn =
        list.filter(
          b => b.status === "checked_in"
        ).length;

      const cancelled =
        list.filter(
          b => b.status === "cancelled"
        ).length;

      const noShow =
        list.filter(
          b => b.status === "no_show"
        ).length;

      // ==========================
      // Average waiting time
      // ==========================

      let waitTotal = 0;
      let waitCount = 0;

      list.forEach(item => {

        if (
          item.called_at &&
          item.created_at
        ) {

          const mins =
            (
              new Date(item.called_at) -
              new Date(item.created_at)
            ) /
            60000;

          waitTotal += mins;
          waitCount++;

        }

      });

      const averageWait =
        waitCount > 0
          ? Math.round(waitTotal / waitCount)
          : 0;

      // ==========================
      // Peak Hour
      // ==========================

      const hours = {};

      list.forEach(item => {

        if (!item.created_at) return;

        const hour =
          new Date(item.created_at)
            .getHours();

        hours[hour] =
          (hours[hour] || 0) + 1;

      });

      let peakHour = null;
      let peakCount = 0;

      Object.keys(hours).forEach(hour => {

        if (hours[hour] > peakCount) {

          peakCount = hours[hour];
          peakHour = hour;

        }

      });

      // ==========================
      // Busiest Department
      // ==========================

      const departments = {};

      list.forEach(item => {

        const name =
          item.hospital_departments
            ?.name ||
          "Unknown";

        departments[name] =
          (departments[name] || 0) + 1;

      });

      let busiestDepartment = null;
      let busiestCount = 0;

      Object.keys(departments).forEach(
        dept => {

          if (
            departments[dept] >
            busiestCount
          ) {

            busiestDepartment = dept;
            busiestCount =
              departments[dept];

          }

        }
      );

      const cancellationRate =
        totalPatients > 0
          ? Number(
              (
                (cancelled /
                  totalPatients) *
                100
              ).toFixed(1)
            )
          : 0;

      const noShowRate =
        totalPatients > 0
          ? Number(
              (
                (noShow /
                  totalPatients) *
                100
              ).toFixed(1)
            )
          : 0;

      return res.json({
        success: true,
        analytics: {

          total_patients:
            totalPatients,

          patients_served_today:
            completed,

          waiting,

          called,

          checked_in:
            checkedIn,

          completed,

          cancelled,

          no_show:
            noShow,

          average_wait_minutes:
            averageWait,

          busiest_department:
            busiestDepartment,

          busiest_department_count:
            busiestCount,

          peak_hour:
            peakHour === null
              ? null
              : `${String(
                  peakHour
                ).padStart(
                  2,
                  "0"
                )}:00`,

          cancellation_rate:
            cancellationRate,

          no_show_rate:
            noShowRate,

        },
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
   GET TODAY'S CHECKED-IN PATIENTS
========================================================= */

router.get(
  "/checkin-list",
  authenticate,
  hospitalAdminAuth,
  async (req, res) => {
    try {
      const hospitalId =
        req.hospitalAdmin.hospital_id;

      const today = new Date()
        .toISOString()
        .split("T")[0];

      const { data, error } =
        await supabaseAdmin
          .from("hospital_bookings")
          .select(`
            id,
            queue_number,
            booking_code,
            status,
            condition,
            checked_in,
            hospital_departments(
              id,
              name
            )
          `)
          .eq("hospital_id", hospitalId)
          .eq("booking_date", today)
          .eq("status", "checked_in")
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
        patients: data || [],
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

await supabaseAdmin
  .from("hospital_notifications")
  .insert({
    hospital_id: booking.hospital_id,
    patient_id: booking.patient_id,
    booking_id: booking.id,
    title,
    message: body,
  });
    }
    /* =========================================================
   NOTIFY NEXT PATIENTS
========================================================= */

if (status === "called") {

  notifyNextPatients(
    booking.hospital_id,
    booking.department_id,
    booking.booking_date
  ).catch(err =>
    console.log(
      "Next patient notification failed:",
      err.message
    )
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

    notifyUser(
  booking.patient_id,
  "Checked In",
  "You have successfully checked in. Please wait to be called."
).catch(err =>
 console.log("Notification failed:", err)
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

/* =========================================================
   CREATE HOSPITAL ADMIN
========================================================= */

router.post(
  "/create-hospital-admin",
  authenticate,
  async (req, res) => {
    try {

      const {
        email,
        password,
        full_name,
        hospital_id,
        role,
      } = req.body;


      if (
        !email ||
        !full_name ||
        !hospital_id
      ) {
        return res.status(400).json({
          error: "Missing required fields",
        });
      }


      let userId;
      let existingUser = false;


      // CREATE AUTH USER

      const {
        data: authData,
        error: authError,
      } =
      await supabaseAdmin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
      });


      if (authData?.user) {
        userId = authData.user.id;
      }



      // EXISTING NASARA USER

      if (authError) {

        const msg =
          authError.message?.toLowerCase() || "";


        if (
          msg.includes("already") ||
          msg.includes("exists")
        ) {

          existingUser = true;


          const {
            data,
            error,
          } =
          await supabaseAdmin.auth.admin.listUsers({
            page:1,
            perPage:1000,
          });


          if(error){
            return res.status(400).json({
              error:error.message
            });
          }


          const found =
          data.users.find(
            u =>
            u.email?.toLowerCase()
            === email.toLowerCase()
          );


          if(!found){

            return res.status(400).json({
              error:"Existing user not found"
            });

          }


          userId = found.id;


        } else {

          return res.status(400).json({
            error:authError.message
          });

        }
      }



      if(!userId){

        return res.status(400).json({
          error:"Unable to find user"
        });

      }



      // CHECK IF ALREADY ADMIN

      const {
        data: existingAdmin
      } =
      await supabaseAdmin
      .from("hospital_admins")
      .select("id")
      .eq("user_id",userId)
      .maybeSingle();



      if(existingAdmin){

        return res.status(400).json({
          error:"User already hospital admin"
        });

      }



      // INSERT ADMIN

      const {
        error:insertError
      } =
      await supabaseAdmin
      .from("hospital_admins")
      .insert({

        user_id:userId,

        hospital_id,

        full_name,

        role:
        role || "admin",

        status:"approved"

      });



      if(insertError){

        return res.status(400).json({
          error:insertError.message
        });

      }



      return res.json({

        success:true,

        existing_user:existingUser,

        user_id:userId

      });



    } catch(err){

      console.log(err);

      return res.status(500).json({
        error:err.message
      });

    }
  }
);
/* =========================================================
   GET NEAREST EMERGENCY HOSPITALS
========================================================= */

router.get(
  "/emergency-hospitals",
  async (req, res) => {
    try {

      const {
        latitude,
        longitude,
      } = req.query;

      const userLat = Number(latitude);
      const userLng = Number(longitude);

      const { data, error } =
        await supabaseAdmin
          .from("hospitals")
          .select(`
            id,
            name,
            phone,
            address,
            city,
            district,
            region,
            latitude,
            longitude,
            has_emergency
          `)
          .eq("is_active", true)
          .eq("has_emergency", true);

      if (error) {
        return res.status(400).json({
          success: false,
          error: error.message,
        });
      }

      // If GPS wasn't provided,
      // return hospitals normally.
      if (
        isNaN(userLat) ||
        isNaN(userLng)
      ) {
        return res.json({
          success: true,
          hospitals: data || [],
        });
      }

      const toRadians = value =>
        value * (Math.PI / 180);

      const hospitals =
        (data || []).map(hospital => {

          const lat =
            Number(hospital.latitude);

          const lng =
            Number(hospital.longitude);

          let distance = null;

          if (
            !isNaN(lat) &&
            !isNaN(lng)
          ) {

            const R = 6371;

            const dLat =
              toRadians(
                lat - userLat
              );

            const dLng =
              toRadians(
                lng - userLng
              );

            const a =
              Math.sin(dLat / 2) *
                Math.sin(dLat / 2) +
              Math.cos(
                toRadians(userLat)
              ) *
                Math.cos(
                  toRadians(lat)
                ) *
                Math.sin(dLng / 2) *
                Math.sin(dLng / 2);

            const c =
              2 *
              Math.atan2(
                Math.sqrt(a),
                Math.sqrt(1 - a)
              );

            distance =
              Number(
                (R * c).toFixed(2)
              );

          }

          return {
            ...hospital,
            distance_km: distance,
          };

        });

      hospitals.sort((a, b) => {

        if (a.distance_km == null)
          return 1;

        if (b.distance_km == null)
          return -1;

        return (
          a.distance_km -
          b.distance_km
        );

      });

      return res.json({
        success: true,
        hospitals,
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
   GET HOSPITAL NOTIFICATIONS
========================================================= */

router.get(
  "/notifications",
  authenticate,
  hospitalAdminAuth,
  async (req, res) => {
    try {
      const hospitalId =
        req.hospitalAdmin.hospital_id;

      const { data, error } =
        await supabaseAdmin
          .from("hospital_notifications")
          .select(`
            *,
            hospital_bookings(
              queue_number
            )
          `)
          .eq("hospital_id", hospitalId)
          .order("created_at", {
            ascending: false,
          });

      if (error) {
        return res.status(400).json({
          success: false,
          error: error.message,
        });
      }

      return res.json({
        success: true,
        notifications: data || [],
      });

    } catch (err) {
      return res.status(500).json({
        success: false,
        error: err.message,
      });
    }
  }
);
/* =========================================================
   MARK NOTIFICATION READ
========================================================= */

router.post(
  "/notification-read",
  authenticate,
  hospitalAdminAuth,
  async (req, res) => {
    try {

      const { notification_id } = req.body;

      if (!notification_id) {
        return res.status(400).json({
          success: false,
          error: "notification_id is required",
        });
      }

      const { data, error } =
        await supabaseAdmin
          .from("hospital_notifications")
          .update({
            is_read: true,
          })
          .eq("id", notification_id)
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
        notification: data,
      });

    } catch (err) {
      return res.status(500).json({
        success: false,
        error: err.message,
      });
    }
  }
);

module.exports = router;