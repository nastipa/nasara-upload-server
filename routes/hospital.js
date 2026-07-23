const express = require("express");
const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");
const notifyUser = require("../services/notifyUser");
/* =========================================================
   CREATE HOSPITAL NOTIFICATION
========================================================= */

async function createHospitalNotification({

  hospital_id,

  patient_id = null,

  booking_id = null,

  title,

  message,

}) {

  try {

    await supabaseAdmin

      .from("hospital_notifications")

      .insert({

        hospital_id,

        patient_id,

        booking_id,

        title,

        message,

      });

  } catch (err) {

    console.error(

      "Hospital notification:",

      err.message

    );

  }

}
/* =========================================================
   HOSPITAL ACTIVITY LOGGER
========================================================= */

async function logHospitalActivity({

  hospital_id,

  booking_id = null,

  patient_id = null,

  admin_id = null,

  action,

  description = null,

  metadata = {},

}) {

  try {

    await supabaseAdmin
      .from("hospital_activity_logs")
      .insert({

        hospital_id,

        booking_id,

        patient_id,

        admin_id,

        action,

        description,

        metadata,

      });

  } catch (err) {

    console.error(
      "Hospital activity:",
      err.message
    );

  }

}
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
        .order("priority_level", {
  ascending: true,
})
.order("queue_position", {
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


if(patient.patient_id){

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

}


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
function suggestPriority(condition) {

  if (!condition) {
    return {
      priority: "normal",
      level: 3,
    };
  }


  const text =
    condition.toLowerCase();



  // Highest priority
  const emergencyWords = [
    "chest pain",
    "difficulty breathing",
    "cannot breathe",
    "unconscious",
    "severe bleeding",
    "stroke",
    "heart attack",
    "convulsion",
    "accident",
    "critical",
    "severe injury",
    "collapsed",
  ];



  // Urgent cases
  const urgentWords = [
    "high fever",
    "severe pain",
    "vomiting",
    "dehydration",
    "infection",
    "pregnancy pain",
    "bleeding pregnancy",
    "labour pain",
    "child very sick",
  ];



  // Special priority cases
  const specialPriorityWords = [
    "elderly",
    "old person",
    "aged",
    "disabled",
    "disability",
    "wheelchair",
    "pregnant",
    "pregnancy",
    "infant",
    "baby",
    "newborn",
    "referral",
    "referred",
    "transfer patient",
  ];



  const lowWords = [
    "checkup",
    "routine",
    "follow up",
    "minor",
    "review",
  ];



  if (
    emergencyWords.some(
      word => text.includes(word)
    )
  ) {
    return {
      priority: "emergency",
      level: 1,
    };
  }



  if (
    urgentWords.some(
      word => text.includes(word)
    )
  ) {
    return {
      priority: "urgent",
      level: 2,
    };
  }



  /*
    Special cases:
    These should not override emergency/urgent,
    but they should come before normal patients.
  */
  if (
    specialPriorityWords.some(
      word => text.includes(word)
    )
  ) {
    return {
      priority: "urgent",
      level: 2,
    };
  }



  if (
    lowWords.some(
      word => text.includes(word)
    )
  ) {
    return {
      priority: "low",
      level: 4,
    };
  }



  return {
    priority: "normal",
    level: 3,
  };

}
/* =========================================================
   SAVE PATIENT JOURNEY
========================================================= */

async function savePatientJourney({

  booking_id,

  hospital_id,

  patient_id = null,

  patient_record_id = null,

  from_department_id = null,

  to_department_id = null,

  department_id = null,

  event_type,

  action,

  notes = null,

  performed_by = null,

}) {
  try {
    const { error } =
      await supabaseAdmin
        .from("hospital_patient_journey")
        .insert({

  booking_id,

  hospital_id,

  patient_id,

  patient_record_id,

  from_department_id,

  to_department_id,

  department_id,

  event_type,

  action,

  notes,

  performed_by,

});
    if (error) {
      console.log(
        "Patient Journey Error:",
        error.message
      );
    }

  } catch (err) {

    console.log(
      "Patient Journey Exception:",
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
  patient_record_id,
  department_id,
  condition,
  priority_case,
  hospital_id: bodyHospitalId,
} = req.body;

    // Check if current user is hospital admin
    const { data: admin } =
      await supabaseAdmin
        .from("hospital_admins")
        .select("hospital_id")
        .eq("user_id", req.user.id)
        .eq("status", "approved")
        .maybeSingle();

    const isHospitalAdmin = !!admin;

    let hospital_id;
    let queuePatientId;
    let bookingPatientRecordId;

    // ==============================
    // HOSPITAL ADMIN BOOKING
    // ==============================

    if (isHospitalAdmin) {

      hospital_id = admin.hospital_id;

      if (!patient_record_id) {
        return res.status(400).json({
          success: false,
          error:
            "patient_record_id is required for admin booking",
        });
      }

      const {
        data: patientRecord,
        error: patientError,
      } = await supabaseAdmin
        .from("patient_records")
        .select("id,user_id")
        .eq("id", patient_record_id)
        .single();

      if (patientError) {
        return res.status(400).json({
          success: false,
          error: patientError.message,
        });
      }

      if (!patientRecord) {
        return res.status(404).json({
          success: false,
          error: "Patient record not found",
        });
      }

      bookingPatientRecordId = patientRecord.id;

      // Walk-in patients have no account.
      // Registered patients have a user_id.
      queuePatientId = patientRecord.user_id || null;

    } else {

      // ==============================
      // NORMAL PATIENT BOOKING
      // ==============================

      hospital_id = bodyHospitalId;

      queuePatientId = req.user.id;

      const {
        data: patientRecord,
        error: patientError,
      } = await supabaseAdmin
        .from("patient_records")
        .select("id")
        .eq("user_id", req.user.id)
        .maybeSingle();

      if (patientError) {
        return res.status(400).json({
          success: false,
          error: patientError.message,
        });
      }

      if (!patientRecord) {
        return res.status(404).json({
          success: false,
          error:
            "Patient profile not found. Please complete your patient registration first.",
        });
      }

      bookingPatientRecordId = patientRecord.id;
    }

    if (!hospital_id) {
      return res.status(400).json({
        success: false,
        error: "Hospital is required",
      });
    }
    const today =
  new Date()
    .toISOString()
    .split("T")[0];

const { data: existingBooking } =
  await supabaseAdmin
    .from("hospital_bookings")
    .select("id, queue_number")
    .eq("hospital_id", hospital_id)
    .eq("patient_record_id", bookingPatientRecordId)
    .eq("booking_date", today)
    .in("status", [
      "waiting",
      "checked_in",
      "called",
    ])
    .maybeSingle();

if (existingBooking) {

  return res.status(400).json({
    success: false,
    error:
      `You already have an active booking today. Queue number: ${existingBooking.queue_number}`,
  });

}
    // Today's date
    const bookingDate =
      new Date()
        .toISOString()
        .split("T")[0];
        /* ==============================
   GET SELECTED DEPARTMENT
============================== */

if (!department_id) {

  return res.status(400).json({
    success: false,
    error: "Department is required."
  });

}

const { data: department, error: depError } =
  await supabaseAdmin
    .from("hospital_departments")
    .select("*")
    .eq("hospital_id", hospital_id)
    .eq("id", department_id)
    .eq("is_active", true)
    .maybeSingle();

if (depError || !department) {
  return res.status(400).json({
    success: false,
    error: "Department not found.",
  });
}

/* ==============================
   COUNT QUEUE NUMBER
============================== */

const {
  count
} =
await supabaseAdmin
  .from("hospital_bookings")
  .select("*", {
    count:"exact",
    head:true
  })
  .eq(
    "hospital_id",
    hospital_id
  )
  .eq(
    "department_id",
    department_id
  )
  .eq(
    "booking_date",
    bookingDate
  );


const queuePosition =
  (count || 0) + 1;



const queueNumber =
  `${department.name.substring(0,3).toUpperCase()}-${String(queuePosition).padStart(3,"0")}`;



/* ==============================
   BOOKING CODE
============================== */

const bookingCode =
  "NHS-" +
  crypto
    .randomBytes(3)
    .toString("hex")
    .toUpperCase();



/* ==============================
   WAIT TIME
============================== */

const estimatedWait =
queuePosition *
(department.average_minutes || 10);


/* ==============================
   PRIORITY HANDLING
   Hospital walk-in:
   staff selects priority

   Online booking:
   system suggests priority
============================== */


let finalPriority;


// Hospital admin/reception booking
if (
  isHospitalAdmin &&
  priority_case
) {


  const priorityMap = {

    emergency:{
      priority:"emergency",
      level:1,
    },


    urgent:{
      priority:"urgent",
      level:2,
    },


    infant:{
      priority:"infant",
      level:3,
    },


    pregnant:{
      priority:"pregnant",
      level:4,
    },


    elderly:{
      priority:"elderly",
      level:5,
    },


    disability:{
      priority:"disability",
      level:6,
    },


    referral:{
      priority:"referral",
      level:7,
    },


    normal:{
      priority:"normal",
      level:8,
    },

  };


  finalPriority =
    priorityMap[
      priority_case.toLowerCase()
    ] ||
    priorityMap.normal;


} else {


  // Online patient booking
  // Use condition description
  // to suggest priority

  finalPriority =
    suggestPriority(condition);


}



/* ==============================
   INSERT BOOKING
============================== */

const {
  data: booking,
  error: bookingError
} =
await supabaseAdmin
  .from("hospital_bookings")
  .insert({

    hospital_id,

    // NULL for walk-in patients
    // Auth ID for registered patients
    patient_id:
      queuePatientId,


    patient_record_id:
      bookingPatientRecordId,


    department_id: department_id,


    booking_date:
      bookingDate,


    condition:
      condition || null,


   priority:
  finalPriority.priority,

priority_level:
  finalPriority.level,


    queue_number: queueNumber,
queue_position: queuePosition,

    booking_code:
      bookingCode,


    qr_code:
      bookingCode,


    estimated_wait_minutes:
      estimatedWait,


    status:
      "waiting"

  })
  .select()
  .single();


if (bookingError) {

  return res.status(400).json({
    success:false,
    error:bookingError.message
  });

}
const { count: duplicateQueue } =
  await supabaseAdmin
    .from("hospital_bookings")
    .select("*", {
      count: "exact",
      head: true,
    })
    .eq("hospital_id", hospital_id)
    .eq("department_id", department_id)
    .eq("booking_date", bookingDate)
    .eq("queue_position", queuePosition);

if ((duplicateQueue || 0) > 1) {
  console.error(
    "Duplicate queue position detected:",
    queuePosition
  );
}
/* ==============================
   SEND QUEUE NOTIFICATION
============================== */

// Only notify if patient has an account
if (queuePatientId) {

  await supabaseAdmin
    .from("hospital_notifications")
    .insert({

      hospital_id,

      patient_id:
        queuePatientId,


      booking_id:
        booking.id,


      title:
        "Queue Joined",


      message:
      `You have joined the ${department.name} queue. Your queue number is ${queueNumber}. Estimated waiting time is ${estimatedWait} minutes.`

    });


  notifyUser(
    queuePatientId,
    "Queue Joined",
    `Your queue number is ${queueNumber}. Estimated waiting time is ${estimatedWait} minutes.`
  )
  .catch(err =>
    console.log(
      "Notification error:",
      err.message
    )
  );

}


/* ==============================
   SAVE PATIENT JOURNEY
============================== */

await savePatientJourney({

  booking_id: booking.id,

  hospital_id,

  patient_id: queuePatientId,

  patient_record_id: bookingPatientRecordId,

 department_id: department_id,

  event_type: "joined_queue",

  action: "Joined Queue",

  notes: `Patient joined ${department.name} queue`,
  performed_by: isHospitalAdmin
    ? req.user.id
    : queuePatientId,

});


/* ==============================
   RESPONSE
============================== */

return res.json({

  success: true,

  booking,

});

} catch(err) {


console.log(
  "join queue error:",
  err
);


return res.status(500).json({

  success:false,

  error:err.message

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
              name,
              average_minutes
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
         .lt("queue_position", booking.queue_position);

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
    .in("status", [
      "waiting",
      "checked_in",
      "called",
    ])
    .order("created_at", {
      ascending: false,
    })
    .limit(1)
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
      const {data:hospital}=await supabaseAdmin
.from("hospitals")
.select("name")
.eq("id",booking.hospital_id)
.single();


const {data:department}=await supabaseAdmin
.from("hospital_departments")
.select("name")
.eq("id",booking.department_id)
.single();

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
          .order("priority_level", {
  ascending: true,
})
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
    .lt("queue_position", booking.queue_position);

const estimatedWait =
  (peopleAhead || 0) * 10;

      return res.json({
  success: true,

  queue: {

    hospital:
      hospital?.name || "",

    department:
      department?.name || "",

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

   people_ahead:
  peopleAhead || 0,

estimated_wait_minutes:
  estimatedWait,

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
   HOSPITAL HISTORY
========================================================= */

router.get(
  "/history",
  authenticate,
  hospitalAdminAuth,
  async (req, res) => {

    try {

      const hospitalId =
        req.hospitalAdmin.hospital_id;

      const date =
        req.query.date ||
        new Date()
          .toISOString()
          .split("T")[0];

      const {
        data,
        error,
      } =
      await supabaseAdmin
        .from("hospital_bookings")
        .select(`
  id,
  booking_code,
  status,
  priority,
  booking_date,
  created_at,
  arrived_at,
  called_at,
  completed_at,
  department_id,
  current_stage,
  hospital_departments(
    id,
    name
  )
`)
        .eq("hospital_id", hospitalId)
        .eq("booking_date", date);

      if (error) {

        return res.status(400).json({

          success:false,

          error:error.message

        });

      }

      const list = data || [];

const totalPatients =
  list.length;

const completed =
  list.filter(
    x => x.status === "completed"
  ).length;

const waiting =
  list.filter(
    x => x.status === "waiting"
  ).length;

const called =
  list.filter(
    x => x.status === "called"
  ).length;

const checkedIn =
  list.filter(
    x => x.status === "checked_in"
  ).length;

const cancelled =
  list.filter(
    x => x.status === "cancelled"
  ).length;

const noShow =
  list.filter(
    x => x.status === "no_show"
  ).length;
  // Department summary

const departmentSummary = {};

list.forEach(item => {

  const dept =
    item.hospital_departments?.name ||
    "Unknown";

  departmentSummary[dept] =
    (departmentSummary[dept] || 0) + 1;

});
// Hourly summary

const hourlySummary = {};

list.forEach(item => {

  if (!item.created_at) return;

  const hour =
    new Date(item.created_at)
      .getHours();

  hourlySummary[hour] =
    (hourlySummary[hour] || 0) + 1;

});
return res.json({

  success: true,

  summary: {

    date,

    total_patients: totalPatients,

    waiting,

    called,

    checked_in: checkedIn,

    completed,

    cancelled,

    no_show: noShow,

    departments: departmentSummary,

    hourly: hourlySummary,

  },

  patients: list,

});
    } catch(err){

      return res.status(500).json({

        success:false,

        error:err.message

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
  hospital_departments!hospital_bookings_department_id_fkey(
    id,
    name
  )
`)
      .eq("hospital_id", hospitalId)
      .eq("booking_date", today)
      .order("priority_level", {
  ascending: true,
})
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
   LIVE DEPARTMENT DASHBOARD
========================================================= */

router.post(
  "/department-dashboard",
  authenticate,
  hospitalAdminAuth,
  async (req, res) => {

    try {

      const hospitalId =
        req.hospitalAdmin.hospital_id;

      const {
        department_id,
      } = req.body;

      if (!department_id) {

        return res.status(400).json({

          error:
            "department_id is required",

        });

      }

      const {
        data: department,
        error: departmentError,
      } =
        await supabaseAdmin
          .from(
            "hospital_departments"
          )
          .select(`
            id,
            name,
            average_minutes
          `)
          .eq(
            "id",
            department_id
          )
          .eq(
            "hospital_id",
            hospitalId
          )
          .single();

      if (
        departmentError ||
        !department
      ) {

        return res.status(404).json({

          error:
            "Department not found",

        });

      }

      const today =
        new Date()
          .toISOString()
          .split("T")[0];

      const {
        data: bookings,
        error: bookingError,
      } =
        await supabaseAdmin
          .from(
            "hospital_bookings"
          )
          .select(`
  id,
  queue_number,
  booking_code,
  patient_record_id,
  priority,
  priority_level,
  status,
  checked_in,
  condition,
  created_at
`)
          .eq(
            "hospital_id",
            hospitalId
          )
          .eq(
            "department_id",
            department_id
          )
          .eq(
            "booking_date",
            today
          )
          .order(
            "priority_level",
            {
              ascending: true,
            }
          )
          .order(
            "created_at",
            {
              ascending: true,
            }
          );

      if (bookingError) {

        return res.status(400).json({

          error:
            bookingError.message,

        });

      }
      const patientIds = bookings
  .map(b => b.patient_record_id)
  .filter(Boolean);

let patientMap = {};

if (patientIds.length > 0) {

  const {
    data: patients,
    error: patientError,
  } = await supabaseAdmin
    .from("patient_records")
    .select(`
      id,
      full_name
    `)
    .in("id", patientIds);

  if (!patientError && patients) {

    patientMap = patients.reduce(
      (acc, patient) => {

        acc[patient.id] = patient.full_name;

        return acc;

      },
      {}
    );

  }

}
      const statistics = {

  waiting:
    bookings.filter(
      b => b.status === "waiting"
    ).length,

  called:
    bookings.filter(
      b => b.status === "called"
    ).length,

  checked_in:
    bookings.filter(
      b => b.status === "checked_in"
    ).length,

  completed:
    bookings.filter(
      b => b.status === "completed"
    ).length,

  emergency:
    bookings.filter(
      b => b.priority === "emergency"
    ).length,

  urgent:
    bookings.filter(
      b => b.priority === "urgent"
    ).length,

  total_today:
    bookings.length,

};
      const currentPatient =
        bookings.find(
          b =>
            b.status ===
            "called"
        ) || null;

      const queue =
        bookings.map(
          booking => ({

            booking_id:
              booking.id,

            queue_number:
              booking.queue_number,

            booking_code:
              booking.booking_code,

            patient_name:
  patientMap[
    booking.patient_record_id
  ] || "Unknown Patient",

            priority:
              booking.priority,

            priority_level:
              booking.priority_level,

            status:
              booking.status,

            checked_in:
              booking.checked_in,

            condition:
              booking.condition,

            created_at:
              booking.created_at,

          })
        );

      return res.json({

        department: {

          id:
            department.id,

          name:
            department.name,

          average_minutes:
            department.average_minutes,

        },

        statistics,

        current_patient:
          currentPatient
            ? {

                booking_id:
                  currentPatient.id,

                queue_number:
                  currentPatient.queue_number,

                booking_code:
                  currentPatient.booking_code,

                patient_name:
  patientMap[
    currentPatient.patient_record_id
  ] || "Unknown Patient",
                priority:
                  currentPatient.priority,

                priority_level:
                  currentPatient.priority_level,

                status:
                  currentPatient.status,

                checked_in:
                  currentPatient.checked_in,

                condition:
                  currentPatient.condition,

                created_at:
                  currentPatient.created_at,

              }
            : null,

        queue,

      });

    } catch (err) {

      console.error(err);

      return res.status(500).json({

        error:
          err.message,

      });

    }

  }
);

/* =========================================================
   HOSPITAL EXECUTIVE ANALYTICS
========================================================= */

router.get(
  "/executive-analytics",
  authenticate,
  hospitalAdminAuth,
  async (req, res) => {

    try {

      const hospitalId =
        req.hospitalAdmin.hospital_id;

     const today =
  new Date().toISOString().split("T")[0];

// Total bookings today
const {
  count: totalBookings,
} = await supabaseAdmin
  .from("hospital_bookings")
  .select("*", {
    count: "exact",
    head: true,
  })
  .eq("hospital_id", hospitalId)
  .eq("booking_date", today);

// Completed today
const {
  count: completedPatients,
} = await supabaseAdmin
  .from("hospital_bookings")
  .select("*", {
    count: "exact",
    head: true,
  })
  .eq("hospital_id", hospitalId)
  .eq("booking_date", today)
  .eq("status", "completed");

// Waiting today
const {
  count: waitingPatients,
} = await supabaseAdmin
  .from("hospital_bookings")
  .select("*", {
    count: "exact",
    head: true,
  })
  .eq("hospital_id", hospitalId)
  .eq("booking_date", today)
  .eq("status", "waiting");

// Called today
const {
  count: calledPatients,
} = await supabaseAdmin
  .from("hospital_bookings")
  .select("*", {
    count: "exact",
    head: true,
  })
  .eq("hospital_id", hospitalId)
  .eq("booking_date", today)
  .eq("status", "called");

// Checked in today
const {
  count: checkedInPatients,
} = await supabaseAdmin
  .from("hospital_bookings")
  .select("*", {
    count: "exact",
    head: true,
  })
  .eq("hospital_id", hospitalId)
  .eq("booking_date", today)
  .eq("status", "checked_in");
 
  const {
  count: emergencyPatients,
} = await supabaseAdmin
  .from("hospital_bookings")
  .select("*", {
    count: "exact",
    head: true,
  })
  .eq("hospital_id", hospitalId)
  .eq("booking_date", today)
  .eq("priority", "emergency");

  const {
  data: bookingTimes,
} = await supabaseAdmin
  .from("hospital_bookings")
  .select(`
    created_at,
    called_at,
    completed_at
  `)
  .eq("hospital_id", hospitalId)
  .eq("booking_date", today);

  let waitingMinutes = 0;
let waitingCount = 0;

let consultationMinutes = 0;
let consultationCount = 0;

(bookingTimes || []).forEach(item => {

  if (
    item.created_at &&
    item.called_at
  ) {

    waitingMinutes +=
      (
        new Date(item.called_at) -
        new Date(item.created_at)
      ) / 60000;

    waitingCount++;

  }

  if (
    item.called_at &&
    item.completed_at
  ) {

    consultationMinutes +=
      (
        new Date(item.completed_at) -
        new Date(item.called_at)
      ) / 60000;

    consultationCount++;

  }

});

const averageWaitingTime =
  waitingCount
    ? Math.round(
        waitingMinutes /
        waitingCount
      )
    : 0;

const averageConsultationTime =
  consultationCount
    ? Math.round(
        consultationMinutes /
        consultationCount
      )
    : 0;

const analytics = {

  total_bookings:
    totalBookings || 0,

  completed_patients:
    completedPatients || 0,

  waiting_patients:
    waitingPatients || 0,

  called_patients:
    calledPatients || 0,

  checked_in_patients:
    checkedInPatients || 0,

  emergency:
    emergencyPatients || 0,

  average_waiting_time:
    averageWaitingTime,

  average_consultation_time:
    averageConsultationTime,

};
return res.json({
  success: true,
  analytics,
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
   HOSPITAL LIVE NOTIFICATIONS
========================================================= */

router.get(
  "/live-notifications",
  authenticate,
  hospitalAdminAuth,
  async (req, res) => {

    try {

      const hospitalId =
        req.hospitalAdmin.hospital_id;

      const { data, error } =
        await supabaseAdmin
          .from("hospital_notifications")
          .select("*")
          .eq("hospital_id", hospitalId)
          .order("created_at", {
            ascending: false,
          })
          .limit(50);

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
     if (name !== undefined) {

  const { data: existingDepartment } =
    await supabaseAdmin
      .from("hospital_departments")
      .select("id")
      .eq("hospital_id", hospitalId)
      .ilike("name", name.trim())
      .neq("id", department_id)
      .maybeSingle();

  if (existingDepartment) {

    return res.status(400).json({
      success: false,
      error: "Another department with this name already exists.",
    });

  }

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
     const { count: activeBookings } =
  await supabaseAdmin
    .from("hospital_bookings")
    .select("*", {
      count: "exact",
      head: true,
    })
    .eq("department_id", id)
    .in("status", [
      "waiting",
      "called",
      "checked_in",
    ]);

if ((activeBookings || 0) > 0) {

  return res.status(400).json({
    success: false,
    error:
      "This department cannot be deleted because patients are still assigned to it.",
  });

}
     const { count: staffCount } =
await supabaseAdmin
.from("hospital_department_staff")
.select("*", {
  count: "exact",
  head: true,
})
.eq("department_id", id)
.eq("active", true);

if ((staffCount || 0) > 0) {
  return res.status(400).json({
    success:false,
    error:"Department still has active staff."
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
          .eq("is_active", true)
          .order("name");


      if (error) {
        return res.status(400).json({
          success:false,
          error:error.message
        });
      }


      return res.json({
        success:true,
        departments:data || []
      });


    } catch(err) {

      console.log(err);

      return res.status(500).json({
        success:false,
        error:err.message
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
    /* ==============================
   SAVE PATIENT JOURNEY
============================== */

let journeyAction = "";

switch (status) {

  case "called":
    journeyAction = "Called";
    break;

  case "checked_in":
    journeyAction = "Checked In";
    break;

  case "completed":
    journeyAction = "Completed";
    break;

  case "cancelled":
    journeyAction = "Cancelled";
    break;

  case "no_show":
    journeyAction = "No Show";
    break;

  default:
    journeyAction = status;

}

await savePatientJourney({

  booking_id: booking.id,

  hospital_id: booking.hospital_id,

  department_id: booking.department_id,

  action: journeyAction,

  notes: `Patient status changed to ${journeyAction}`,

  performed_by: req.user.id,

});

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

  // Mark this patient as currently being served
  await supabaseAdmin
    .from("hospital_departments")
    .update({
      current_booking_id: booking.id,
    })
    .eq("id", booking.department_id);

  // Queue voice announcement
  await supabaseAdmin
    .from("hospital_voice_queue")
    .insert({
      hospital_id: booking.hospital_id,

      booking_id: booking.id,

      department_id: booking.department_id,

      patient_id: booking.patient_id,

      queue_number: booking.queue_number,

      message: `Queue ${booking.queue_number}, please proceed to your consultation room.`,

      language: "en",

      priority: booking.priority_level || 3,

      played: false,
    });

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
if (
  status === "completed" ||
  status === "cancelled" ||
  status === "no_show"
) {
  await supabaseAdmin
    .from("hospital_departments")
    .update({
      current_booking_id: null,
    })
    .eq("id", booking.department_id);
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
   UPDATE PATIENT TRIAGE PRIORITY
========================================================= */

router.post(
  "/update-priority",
  authenticate,
  hospitalAdminAuth,
  async (req, res) => {

    try {

      const hospitalId =
        req.hospitalAdmin.hospital_id;

      const {
        booking_id,
        priority,
        triage_note,
      } = req.body;


      const priorities = {
  emergency: 1,
  urgent: 2,
  elderly: 2,
  disability: 2,
  pregnant: 2,
  infant: 2,
  referral: 2,
  normal: 3,
  low: 4,
};

      if (!booking_id || !priority) {
        return res.status(400).json({
          success:false,
          error:
          "booking_id and priority are required",
        });
      }


      if (!(priority in priorities)) {
        return res.status(400).json({
          success:false,
          error:
          "Invalid priority",
        });
      }


      // Make sure booking belongs to this hospital

      const { data: booking, error: bookingError } =
        await supabaseAdmin
          .from("hospital_bookings")
          .select("id")
          .eq("id", booking_id)
          .eq("hospital_id", hospitalId)
          .maybeSingle();


      if (bookingError) {
        return res.status(400).json({
          success:false,
          error: bookingError.message,
        });
      }


      if (!booking) {
        return res.status(404).json({
          success:false,
          error:
          "Booking not found",
        });
      }


      const { data, error } =
        await supabaseAdmin
          .from("hospital_bookings")
          .update({

            priority,

            priority_level:
              priorities[priority],

            triage_note:
              triage_note || null,

            triaged_by:
              req.user.id,

            triaged_at:
              new Date().toISOString(),

          })
          .eq("id", booking_id)
          .select()
          .single();



      if (error) {
        return res.status(400).json({
          success:false,
          error:error.message,
        });
      }



      return res.json({

        success:true,

        booking:data,

      });



    } catch(err){

      console.log(err);

      return res.status(500).json({
        success:false,
        error:err.message,
      });

    }

  }
);
/* =========================================================
   SUGGEST PATIENT TRIAGE PRIORITY
========================================================= */

router.post(
  "/suggest-priority",
  authenticate,
  hospitalAdminAuth,
  async(req,res)=>{

    try{

      const {
        condition
      } = req.body;


      const suggestion =
        suggestPriority(condition);


      return res.json({

        success:true,

        suggestion

      });


    }catch(err){

      return res.status(500).json({

        success:false,

        error:err.message

      });

    }

  }
);
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
status: "waiting",
arrived_at: new Date().toISOString(),
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


await supabaseAdmin
.from("hospital_notifications")
.insert({
  hospital_id: booking.hospital_id,
  patient_id: booking.patient_id,
  booking_id: booking.id,
  title:"Checked In",
  message:
  "You have successfully checked in. Please wait to be called."
});
const { data: existingJourney } =
  await supabaseAdmin
    .from("hospital_patient_journey")
    .select("id")
    .eq("booking_id", booking.id)
    .eq("event_type", "checked_in")
    .maybeSingle();

if (!existingJourney) {

  await supabaseAdmin
    .from("hospital_patient_journey")
    .insert({

  booking_id: booking.id,

  hospital_id: booking.hospital_id,

  patient_id: booking.patient_id,

  patient_record_id:
    booking.patient_record_id,

  department_id:
    booking.department_id,

  event_type:
    "checked_in",

  action:
    "Checked In",

  notes:
    "Patient arrived and checked in.",

  performed_by:
    req.user.id,

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
   TRANSFER PATIENT TO NEXT DEPARTMENT
========================================================= */

router.post(
  "/transfer-patient",
  authenticate,
  hospitalAdminAuth,
  async (req, res) => {

    try {

      const hospitalId =
        req.hospitalAdmin.hospital_id;

      const {
        booking_id,
        next_department_id,
      } = req.body;

      if (
        !booking_id ||
        !next_department_id
      ) {
        return res.status(400).json({
          success: false,
          error:
            "booking_id and next_department_id are required",
        });
      }

      // Get current booking
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
    .eq("id", booking_id)
    .eq("hospital_id", hospitalId)
    .single();

if (bookingError || !booking) {
  return res.status(404).json({
    success: false,
    error: "Booking not found",
  });
}
if (
  booking.status === "completed" ||
  booking.status === "cancelled" ||
  booking.status === "no_show"
) {
  return res.status(400).json({
    success: false,
    error: "This patient cannot be transferred.",
  });
}
// Get next department
const {
  data: department,
  error: depError,
} = await supabaseAdmin
  .from("hospital_departments")
  .select("*")
  .eq("id", next_department_id)
  .eq("hospital_id", hospitalId)
  .single();

if (depError || !department) {
  return res.status(404).json({
    success: false,
    error: "Department not found",
  });
}

// Next queue number
const { data: lastBooking } =
  await supabaseAdmin
    .from("hospital_bookings")
    .select("queue_position")
    .eq("hospital_id", hospitalId)
    .eq("department_id", next_department_id)
    .eq("booking_date", booking.booking_date)
    .order("queue_position", {
      ascending: false,
    })
    .limit(1)
    .maybeSingle();

const queuePosition =
  (lastBooking?.queue_position || 0) + 1;
const {
  data: selectedDepartment,
} = await supabaseAdmin
  .from("hospital_departments")
  .select("name")
  .eq("id", next_department_id)
  .single();

const queueNumber =
`${selectedDepartment.name.substring(0,3).toUpperCase()}-${String(queuePosition).padStart(3,"0")}`;
// Update booking
const {
  data: updated,
  error: updateError,
} = await supabaseAdmin
  .from("hospital_bookings")
  .update({
  department_id: next_department_id,
  queue_number: queueNumber,
queue_position: queuePosition,
  status: "waiting",
  checked_in: false,
  called_at: null,
  transferred_at: new Date().toISOString(),
})
  .eq("id", booking_id)
  .select()
  .single();

if (updateError) {
  return res.status(400).json({
    success: false,
    error: updateError.message,
  });
}
await supabaseAdmin
  .from("hospital_departments")
  .update({
    current_booking_id: null,
  })
  .eq("id", booking.department_id);
// Record patient journey
await supabaseAdmin
  .from("hospital_patient_journey")
  .insert({

    hospital_id: hospitalId,

    booking_id: booking.id,

    patient_id: booking.patient_id,

    patient_record_id:
      booking.patient_record_id,

    from_department_id:
      booking.department_id,

    to_department_id:
      next_department_id,

    department_id:
      next_department_id,

    event_type:
      "transferred",

    action:
      "Transferred",

    notes:
  `Transferred from ${booking.hospital_departments?.name || "Previous Department"} to ${department.name}`,

    performed_by:
      req.user.id,

  });

// Notify patient
if (booking.patient_id) {

  await notifyUser(
    booking.patient_id,
    "Department Transfer",
    `Please proceed to ${department.name}. Your new queue number is ${queueNumber}.`
  );

  await supabaseAdmin
    .from("hospital_notifications")
    .insert({
      hospital_id: hospitalId,
      patient_id: booking.patient_id,
      booking_id: booking.id,
      title: "Department Transfer",
      message: `Please proceed to ${department.name}. Your new queue number is ${queueNumber}.`
    });

}
await logHospitalActivity({

  hospital_id: hospitalId,

  booking_id: booking.id,

  patient_id: booking.patient_id,

  admin_id: req.user.id,

  action: "patient_transferred",

  description:
    `Transferred to ${department.name}`,

  metadata: {

    from_department:
      booking.department_id,

    to_department:
      next_department_id,

    queue_number: queueNumber,
queue_position: queuePosition,
  },

});
await notifyNextPatients(
  hospitalId,
  next_department_id,
  booking.booking_date
).catch(err =>
  console.log(
    "Transfer notification failed:",
    err.message
  )
);
return res.json({
  success: true,
  booking: updated,
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
   GET HOSPITAL SETTINGS
========================================================= */

router.get(
  "/settings",
  authenticate,
  hospitalAdminAuth,
  async (req, res) => {

    try {

      const hospitalId =
        req.hospitalAdmin.hospital_id;

      const {
        data,
        error,
      } = await supabaseAdmin
        .from("hospital_settings")
        .select("*")
        .eq("hospital_id", hospitalId)
        .maybeSingle();

      if (error) {

        return res.status(400).json({

          success: false,

          error: error.message,

        });

      }

      return res.json({

        success: true,

        settings: data,

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
   UPDATE HOSPITAL SETTINGS
========================================================= */

router.post(
  "/settings",
  authenticate,
  hospitalAdminAuth,
  async (req, res) => {

    try {

      const hospitalId =
        req.hospitalAdmin.hospital_id;

      const {

        hospital_logo,

        hospital_slogan,

        primary_color,

        secondary_color,

        queue_prefix,

        online_queue_prefix,

        walkin_queue_prefix,

        reset_queue_daily,

        max_patients_per_day,

        online_booking_enabled,

        walkin_enabled,

        tv_display_enabled,

        show_waiting_time,

        show_department,

        show_next_patients,

        emergency_mode,

      } = req.body;

      const {

        data,

        error,

      } = await supabaseAdmin
        .from("hospital_settings")
        .upsert({

          hospital_id: hospitalId,

          hospital_logo,

          hospital_slogan,

          primary_color,

          secondary_color,

          queue_prefix,

          online_queue_prefix,

          walkin_queue_prefix,

          reset_queue_daily,

          max_patients_per_day,

          online_booking_enabled,

          walkin_enabled,

          tv_display_enabled,

          show_waiting_time,

          show_department,

          show_next_patients,

          emergency_mode,

          updated_at:
            new Date().toISOString(),

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

        settings: data,

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
   GET WORKING HOURS
========================================================= */

router.get(
  "/working-hours",
  authenticate,
  hospitalAdminAuth,
  async (req, res) => {

    try {

      const hospitalId =
        req.hospitalAdmin.hospital_id;

      const {
        data,
        error,
      } = await supabaseAdmin
        .from("hospital_working_hours")
        .select("*")
        .eq("hospital_id", hospitalId)
        .order("day_of_week", {
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

        working_hours:
          data || [],

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
   SAVE WORKING HOURS
========================================================= */

router.post(
  "/working-hours",
  authenticate,
  hospitalAdminAuth,
  async (req, res) => {

    try {

      const hospitalId =
        req.hospitalAdmin.hospital_id;

      const { working_hours } =
        req.body;

      if (
        !Array.isArray(working_hours)
      ) {

        return res.status(400).json({

          success: false,

          error:
            "working_hours must be an array",

        });

      }

      const rows =
        working_hours.map(item => ({

          hospital_id: hospitalId,

          day_of_week:
            item.day_of_week,

          opening_time:
            item.opening_time,

          closing_time:
            item.closing_time,

          is_closed:
            item.is_closed ?? false,

          is_24_hours:
            item.is_24_hours ?? false,

          updated_at:
            new Date().toISOString(),

        }));

      const {
        data,
        error,
      } = await supabaseAdmin
        .from("hospital_working_hours")
        .upsert(
          rows,
          {
            onConflict:
              "hospital_id,day_of_week",
          }
        )
        .select();

      if (error) {

        return res.status(400).json({

          success: false,

          error: error.message,

        });

      }

      return res.json({

        success: true,

        working_hours: data,

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
   CREATE HOSPITAL ADMIN
========================================================= */

router.post(
  "/create-hospital-admin",
  authenticate,
  async (req, res) => {
    try {
      const adminUserId = req.user.id;


// CHECK SUPER ADMIN PERMISSION

const { data: superAdmin } =
  await supabaseAdmin
    .from("admins")
    .select("id")
    .eq("user_id", adminUserId)
    .maybeSingle();

if (!superAdmin) {
  return res.status(403).json({
    success: false,
    error: "Only Nasara super admin can create hospital administrators."
  });
}const {
  email,
  password,
  full_name,
  hospital_id,
  role,
} = req.body;

      const { data: hospital } =
await supabaseAdmin
.from("hospitals")
.select("id")
.eq("id", hospital_id)
.maybeSingle();


      if (
        !email ||
        !full_name ||
        !hospital_id
      ) {
        return res.status(400).json({
          error: "Missing required fields",
        });
      }
     if(!hospital){
 return res.status(404).json({
  success:false,
  error:"Hospital not found"
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



      if (insertError) {

  if (
    insertError.message
      .toLowerCase()
      .includes("duplicate") ||
    insertError.message
      .toLowerCase()
      .includes("unique")
  ) {

    return res.status(400).json({
      success: false,
      error: "User is already a hospital administrator.",
    });

  }

  return res.status(400).json({
    success: false,
    error: insertError.message,
  });

}

      return res.json({

  success: true,

  existing_user: existingUser,

  user_id: userId,

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
      const hospitalId =
  req.hospitalAdmin.hospital_id;
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
    .eq("hospital_id", hospitalId)
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
/* =========================================================
   GET PATIENT HOSPITAL NOTIFICATIONS
========================================================= */

router.get(
"/patient-notifications",
authenticate,
async(req,res)=>{

try{

const patientId = req.user.id;

const { data, error } = await supabaseAdmin
  .from("hospital_notifications")
  .select(`
    *,
    hospital_bookings(
      queue_number
    )
  `)
  .eq("patient_id", patientId)
  .order("created_at", {
    ascending: false,
  })
  .limit(50);

if(error){

return res.status(400).json({
success:false,
error:error.message
});

}


return res.json({

success:true,

notifications:data || []

});


}catch(err){

return res.status(500).json({

success:false,

error:err.message

});

}

});
/* =========================================================
   SEARCH PATIENT
========================================================= */

router.post(
  "/search-patient",
  authenticate,
  hospitalAdminAuth,
  async (req, res) => {
    try {

      const {
        ghana_card_number,
        nhis_number,
        phone,
      } = req.body;

      if (
        !ghana_card_number &&
        !nhis_number &&
        !phone
      ) {
        return res.status(400).json({
          success: false,
          error:
            "Provide Ghana Card number, NHIS number or phone number.",
        });
      }

      let query = supabaseAdmin
        .from("patient_records")
        .select("*");

      if (ghana_card_number) {
        query = query.eq(
          "ghana_card_number",
          ghana_card_number.trim()
        );
      } else if (nhis_number) {
        query = query.eq(
          "nhis_number",
          nhis_number.trim()
        );
      } else {

  let normalizedPhone =
    phone.trim();

  if (
    normalizedPhone.startsWith("+233")
  ) {
    normalizedPhone =
      "0" +
      normalizedPhone.substring(4);
  }

  if (
    normalizedPhone.startsWith("233")
  ) {
    normalizedPhone =
      "0" +
      normalizedPhone.substring(3);
  }

  query = query.eq(
    "phone",
    normalizedPhone
  );

}

      const {
        data,
        error,
      } = await query.maybeSingle();

      if (error) {
        return res.status(400).json({
          success: false,
          error: error.message,
        });
      }

      if (!data) {
        return res.json({
          success: true,
          exists: false,
          patient: null,
        });
      }

      return res.json({
        success: true,
        exists: true,
        patient: data,
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
   REGISTER PATIENT
========================================================= */

router.post(
  "/register-patient",
  authenticate,
  hospitalAdminAuth,
  async (req, res) => {
    try {

      const {
        full_name,
        phone,
        ghana_card_number,
        nhis_number,
        gender,
        date_of_birth,
        address,
      } = req.body;

      if (!full_name) {
        return res.status(400).json({
          success: false,
          error: "Full name is required.",
        });
      }

      // Prevent duplicate Ghana Card
      if (ghana_card_number) {
        const { data } = await supabaseAdmin
          .from("patient_records")
          .select("id")
          .eq(
            "ghana_card_number",
            ghana_card_number.trim()
          )
          .maybeSingle();

        if (data) {
          return res.status(400).json({
            success: false,
            error:
              "A patient with this Ghana Card number already exists.",
          });
        }
      }

      // Prevent duplicate NHIS
      if (nhis_number) {
        const { data } = await supabaseAdmin
          .from("patient_records")
          .select("id")
          .eq(
            "nhis_number",
            nhis_number.trim()
          )
          .maybeSingle();

        if (data) {
          return res.status(400).json({
            success: false,
            error:
              "A patient with this NHIS number already exists.",
          });
        }
      }

      const { data, error } =
        await supabaseAdmin
          .from("patient_records")
          .insert({
            full_name: full_name.trim(),
            phone: phone?.trim() || null,
            ghana_card_number:
              ghana_card_number?.trim() || null,
            nhis_number:
              nhis_number?.trim() || null,
            gender: gender || null,
            date_of_birth:
              date_of_birth || null,
            address:
              address?.trim() || null,
          })
          .select()
          .single();

      if (error) {

  const msg =
    error.message.toLowerCase();

  if (
    msg.includes("duplicate") ||
    msg.includes("unique")
  ) {

    return res.status(400).json({
      success: false,
      error:
        "Patient already exists.",
    });

  }

  return res.status(400).json({
    success: false,
    error: error.message,
  });

}
      return res.json({
        success: true,
        patient: data,
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
   PATIENT JOURNEY
========================================================= */

router.get(
  "/journey/:booking_id",
  authenticate,
  async (req, res) => {

    try {

      const { booking_id } =
  req.params;


        const { data: booking } =
  await supabaseAdmin
    .from("hospital_bookings")
    .select(`
      id,
      patient_id,
      hospital_id
    `)
    .eq("id", booking_id)
    .maybeSingle();
const hospitalId =
  booking.hospital_id;
if (!booking) {

  return res.status(404).json({
    success: false,
    error: "Booking not found.",
  });

}
// Allow the patient who owns the booking
if (booking.patient_id === req.user.id) {

  // continue

} else {

  // Check if user is a hospital admin
  const { data: admin } =
    await supabaseAdmin
      .from("hospital_admins")
      .select("hospital_id")
      .eq("user_id", req.user.id)
      .maybeSingle();

  if (
    !admin ||
    admin.hospital_id !== booking.hospital_id
  ) {

    return res.status(403).json({
      success: false,
      error: "Access denied.",
    });

  }

}

      const { data, error } =
  await supabaseAdmin
    .from("hospital_patient_journey")
    .select(`
      *,
      hospital_departments(
        id,
        name
      )
    `)
    .eq("hospital_id", hospitalId)
    .eq("booking_id", booking_id)
    .order("created_at", {
      ascending: true,
    });
      if (error) {

        return res.status(400).json({

          success:false,

          error:error.message

        });

      }

      return res.json({

        success:true,

        journey:data || []

      });

    } catch(err){

      return res.status(500).json({

        success:false,

        error:err.message

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
   CREATE HOSPITAL STAFF
========================================================= */

router.post(
  "/create-staff",
  authenticate,
  hospitalAdminAuth,
  async (req, res) => {

    try {

      const hospitalId =
        req.hospitalAdmin.hospital_id;

      const adminId =
        req.user.id;

      const {

        full_name,

        phone,

        email,

        department_id,

        role,

      } = req.body;

      if (
        !full_name ||
        !department_id ||
        !role
      ) {
        return res.status(400).json({
          success: false,
          error:
            "full_name, department_id and role are required.",
        });
      }

      // Check department belongs to hospital

      const {
        data: department,
      } =
        await supabaseAdmin
          .from("hospital_departments")
          .select("id,name")
          .eq("id", department_id)
          .eq("hospital_id", hospitalId)
          .maybeSingle();

      if (!department) {

        return res.status(404).json({

          success: false,

          error:
            "Department not found.",

        });

      }

      // Generate Login ID Prefix

let prefix = "STF";

switch (role) {

  case "doctor":
    prefix = "DOC";
    break;

  case "nurse":
    prefix = "NUR";
    break;

  case "laboratory":
    prefix = "LAB";
    break;

  case "pharmacy":
    prefix = "PHA";
    break;

  case "radiology":
    prefix = "RAD";
    break;

  case "cashier":
    prefix = "CAS";
    break;

  case "reception":
    prefix = "REC";
    break;

  case "records":
    prefix = "RCD";
    break;

  case "department_head":
    prefix = "HOD";
    break;

  case "admin":
    prefix = "ADM";
    break;

  default:
    prefix = "STF";

}

// Count existing staff with same role

const {
  count
} =
await supabaseAdmin
.from("hospital_department_staff")
.select("*", {
  count: "exact",
  head: true,
})
.eq("hospital_id", hospitalId)
.eq("role", role);

const login_id =
`${prefix}${String((count || 0) + 1).padStart(6, "0")}`;

// Temporary 4-digit PIN

const login_pin =
String(
  Math.floor(
    1000 + Math.random() * 9000
  )
);
const {
  data,
  error,
} =
await supabaseAdmin
.from("hospital_department_staff")
.insert({

  hospital_id: hospitalId,

  department_id,

  full_name: full_name.trim(),

  phone: phone?.trim() || null,

  email: email?.trim() || null,

  role,

  login_id,

  login_pin,

  pin_changed: false,

  active: true,

  created_by: adminId,

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

  login_id,

  temporary_pin: login_pin,

  staff: data,

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
   HOSPITAL STAFF LOGIN
========================================================= */

router.post(
  "/staff-login",
  async (req, res) => {

    try {

      const {

        login_id,

        login_pin,

      } = req.body;

      if (
        !login_id ||
        !login_pin
      ) {

        return res.status(400).json({

          success: false,

          error:
            "login_id and login_pin are required.",

        });

      }

      const {
  data: staff,
  error,
} =
await supabaseAdmin
.from("hospital_department_staff")
.select(`
  *,
  hospitals(
    id,
    is_active
  ),
  hospital_departments(
    id,
    name
  )
`)
      .eq(
        "login_id",
        login_id.trim()
      )
      .eq(
        "login_pin",
        login_pin.trim()
      )
      .eq(
        "active",
        true
      )
      .maybeSingle();

      if (error) {

        return res.status(400).json({

          success: false,

          error: error.message,

        });

      }

      if (!staff) {
        if (
  staff.hospitals &&
  staff.hospitals.is_active === false
) {
  return res.status(403).json({
    success: false,
    error: "Hospital account is inactive.",
  });
}
      
        return res.status(401).json({

          success: false,

          error:
            "Invalid Login ID or PIN.",

        });

      }

      return res.json({

        success: true,

        first_login:
          !staff.pin_changed,

        staff,

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
   CHANGE STAFF PIN
========================================================= */

router.post(
  "/change-staff-pin",
  async (req, res) => {

    try {

      const {

        login_id,

        old_pin,

        new_pin,

      } = req.body;

      if (
        !login_id ||
        !old_pin ||
        !new_pin
      ) {

        return res.status(400).json({

          success: false,

          error:
            "login_id, old_pin and new_pin are required.",

        });

      }

      if (
        String(new_pin).length < 4
      ) {

        return res.status(400).json({

          success: false,

          error:
            "PIN must be at least 4 digits.",

        });

      }

      const {

        data: staff,

        error,

      } =
      await supabaseAdmin
      .from("hospital_department_staff")
      .select("*")
      .eq("login_id", login_id)
      .eq("login_pin", old_pin)
      .maybeSingle();

      if (error) {

        return res.status(400).json({

          success: false,

          error: error.message,

        });

      }

      if (!staff) {

        return res.status(401).json({

          success: false,

          error:
            "Invalid Login ID or PIN.",

        });

      }

      const {

        data,

        error: updateError,

      } =
      await supabaseAdmin
      .from("hospital_department_staff")
      .update({

        login_pin: new_pin,

        pin_changed: true,

      })
      .eq("id", staff.id)
      .select()
      .single();

      if (updateError) {

        return res.status(400).json({

          success: false,

          error: updateError.message,

        });

      }

      return res.json({

        success: true,

        message:
          "PIN changed successfully.",

        staff: data,

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
   DEPARTMENT DASHBOARD
========================================================= */

router.post(
  "/staff-department-dashboard",
  async (req, res) => {

    try {

      const {

        login_id,

      } = req.body;

      if (!login_id) {

        return res.status(400).json({

          success: false,

          error: "login_id is required.",

        });

      }

      const {

        data: staff,

        error: staffError,

      } =
      await supabaseAdmin
      .from("hospital_department_staff")
      .select("*")
      .eq("login_id", login_id)
      .eq("active", true)
      .single();

      if (staffError || !staff) {

        return res.status(404).json({

          success: false,

          error: "Staff not found.",

        });

      }

      const today =
        new Date()
          .toISOString()
          .split("T")[0];

      const {

        data: patients,

        error,

      } =
      await supabaseAdmin
      .from("hospital_bookings")
      .select(`
        *,
        patient_records(*)
      `)
      .eq(
        "hospital_id",
        staff.hospital_id
      )
      .eq(
        "department_id",
        staff.department_id
      )
      .eq(
        "booking_date",
        today
      )
      .order(
        "priority_level",
        {
          ascending: true,
        }
      )
      .order(
        "queue_position",
        {
          ascending: true,
        }
      );

      if (error) {

        return res.status(400).json({

          success: false,

          error: error.message,

        });

      }

      return res.json({

        success: true,

        staff,

        patients:
          patients || [],

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
   GET NEXT VOICE ANNOUNCEMENT
========================================================= */

router.get(
  "/voice-queue",
  authenticate,
  hospitalAdminAuth,
  async (req, res) => {

    try {

      const hospitalId =
        req.hospitalAdmin.hospital_id;

      const { data, error } =
        await supabaseAdmin
          .from("hospital_voice_queue")
          .select("*")
          .eq("hospital_id", hospitalId)
          .eq("played", false)
          .order("priority", {
            ascending: true,
          })
          .order("created_at", {
            ascending: true,
          })
          .limit(1);

      if (error) {
        return res.status(400).json({
          success: false,
          error: error.message,
        });
      }

      return res.json({
        success: true,
        announcement:
          data?.[0] || null,
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
   MARK VOICE ANNOUNCEMENT PLAYED
========================================================= */

router.post(
  "/voice-queue/played",
  authenticate,
  hospitalAdminAuth,
  async (req, res) => {

    try {

      const { id } = req.body;

      if (!id) {
        return res.status(400).json({
          success: false,
          error: "Voice queue id is required.",
        });
      }

      const { data, error } =
        await supabaseAdmin
          .from("hospital_voice_queue")
          .update({
            played: true,
            played_at: new Date().toISOString(),
          })
          .eq("hospital_id", hospitalId)
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
        announcement: data,
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