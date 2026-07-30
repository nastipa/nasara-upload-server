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

    console.log("Authenticated User:", userId);

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

    console.log("Hospital Admin:", data.user_id);
    console.log("Hospital:", data.hospital_id);

    if (!data.hospital_id) {
      return res.status(403).json({
        success: false,
        error:
          "Super Admin cannot access hospital routes.",
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
   HOSPITAL DEPARTMENT STAFF AUTH
========================================================= */
async function departmentStaffAuth(req, res, next) {

  try {

    const userId = req.user.id;


    const {
      data: staff,
      error
    } = await supabaseAdmin
      .from("hospital_department_staff")
      .select(`
        id,
        user_id,
        hospital_id,
        department_id,
        full_name,
        role,
        status,
        active
      `)
      .eq("user_id", userId)
      .eq("active", true)
      .eq("status", "approved")
      .single();



    if(error || !staff){

      return res.status(403).json({
        error:
        "You are not an approved department staff member"
      });

    }


    req.departmentStaff = staff;


    next();


  } catch(err){

    return res.status(500).json({
      error: err.message
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
   BUILD VOICE SEQUENCE
========================================================= */
async function buildVoiceSequence(
  hospitalId,
  departmentId
){

  const voices = [];


  // ALWAYS ADD ENGLISH TTS FIRST

  voices.push({

    language:"en",

    audio_type:"tts",

    audio_url:null

  });



  const {
    data: departmentLanguages
  }
  =
  await supabaseAdmin
  .from("hospital_department_languages")
  .select(`
    language,
    display_order
  `)
  .eq(
    "hospital_id",
    hospitalId
  )
  .eq(
    "department_id",
    departmentId
  )
  .eq(
    "enabled",
    true
  )
  .order(
    "display_order",
    {
      ascending:true
    }
  );



  for(
    const item of departmentLanguages || []
  ){


    const {
      data: template
    }
    =
    await supabaseAdmin
    .from("hospital_voice_templates")
    .select(`
      language,
      audio_url
    `)
    .eq(
      "hospital_id",
      hospitalId
    )
    .eq(
      "department_id",
      departmentId
    )
    .eq(
      "language",
      item.language
    )
    .eq(
      "active",
      true
    )
    .maybeSingle();



    console.log(
      "VOICE LANGUAGE:",
      item.language,
      "TEMPLATE:",
      template
    );



    if(template?.audio_url){

      voices.push({

        language:template.language,

        audio_type:"template",

        audio_url:template.audio_url

      });


    } else {


      voices.push({

        language:item.language,

        audio_type:"tts",

        audio_url:null

      });


    }


  }


  return voices;

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
    const { data: staff } =
await supabaseAdmin
.from("hospital_department_staff")
.select("hospital_id")
.eq("user_id", req.user.id)
.eq("active", true)
.eq("status","approved")
.maybeSingle();


const isHospitalStaff = !!staff;
    const isHospitalAdmin = !!admin;

    let hospital_id;
    let queuePatientId;
    let bookingPatientRecordId;

    // ==============================
    // HOSPITAL ADMIN BOOKING
    // ==============================

   if (isHospitalAdmin || isHospitalStaff) {

hospital_id =
  isHospitalAdmin
    ? admin.hospital_id
    : staff.hospital_id;

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

if (!patient_record_id) {
  return res.status(400).json({
    success: false,
    error: "patient_record_id is required.",
  });
}

// Get authenticated user's patient record
const {
  data: userPatientRecord,
  error: userRecordError,
} = await supabaseAdmin
  .from("patient_records")
  .select("id, user_id")
  .eq("id", patient_record_id)
  .eq("user_id", req.user.id)
  .maybeSingle();

if (userRecordError) {
  return res.status(400).json({
    success: false,
    error: userRecordError.message,
  });
}

if (!userPatientRecord) {
  return res.status(403).json({
    success: false,
    error: "Patient record does not belong to this account.",
  });
}

// IMPORTANT FIX
queuePatientId = req.user.id;
bookingPatientRecordId = userPatientRecord.id;
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

// Hospital admin and department staff booking
if (
  (isHospitalAdmin || isHospitalStaff) &&
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

console.log("INSERT BOOKING", {
  hospital_id,
  patient_id: queuePatientId,
  patient_record_id: bookingPatientRecordId,
  department_id,
  bookingDate,
});
console.log("USER ID:", req.user.id);
console.log("QUEUE PATIENT ID:", queuePatientId);
console.log("PATIENT RECORD ID:", bookingPatientRecordId);
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
  performed_by:
  (isHospitalAdmin || isHospitalStaff)
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

      const userId = req.user.id;

const {
  data: patientRecord,
  error: patientError,
} = await supabaseAdmin
  .from("patient_records")
  .select("id")
  .eq("user_id", userId)
  .maybeSingle();

if (patientError || !patientRecord) {
  return res.json({
    success: true,
    progress: null,
  });
}

const { data: booking, error: bookingError } =
  await supabaseAdmin
    .from("hospital_bookings")
    .select(`
      *,
      hospital_departments!hospital_bookings_department_id_fkey(
        id,
        name,
        average_minutes
      ),
      next_department:hospital_departments!hospital_bookings_next_department_id_fkey(
        id,
        name
      ),
      patient_records(
        id,
        full_name
      )
    `)
    .eq("patient_record_id", patientRecord.id)
    .eq("booking_date", today)
    .neq("status", "completed")
    .maybeSingle();
console.log("LIVE QUEUE BOOKING:", booking);
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
          .in("status", [
  "called",
  "checked_in"
])
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

const averageMinutes =
  booking.hospital_departments
    ?.average_minutes || 10;

const estimatedWait =
  Math.max(
    0,
    ahead * averageMinutes
  );

// Percentage through the queue
const progress =
  Math.round(
    ((total - ahead) / total) * 100
  );

      return res.json({
        success: true,
        progress: {

  booking_id:
    booking.id,

  patient_name:
    booking.patient_records?.full_name ||
    "Unknown Patient",

  hospital_id:
    booking.hospital_id,

  department_id:
    booking.department_id,

  department_name:
    booking.hospital_departments?.name,

  current_serving:
    currentServing?.queue_number || null,

  your_number:
    booking.queue_number,

  booking_code:
    booking.booking_code,

  people_ahead:
    ahead,

  estimated_wait_minutes:
    estimatedWait,

  average_minutes:
    averageMinutes,

  progress_percent:
    progress,

  total_patients:
    total,

  status:
    booking.status,

  checked_in:
    booking.checked_in,

  booking_source:
    booking.patient_record_id
      ? "online"
      : "walk_in",

  next_department:
    booking.next_department || null,

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
   HOSPITAL LIVE BOARD
   SHOW ALL DEPARTMENTS
========================================================= */

router.get(
  "/live-board",
  authenticate,
  async (req, res) => {

    try {

      const userId = req.user.id;


      /* --------------------------------
         FIND STAFF HOSPITAL
      -------------------------------- */

      const {
        data: staff,
        error: staffError
      } =
      await supabaseAdmin
      .from("hospital_department_staff")
      .select(`
        hospital_id
      `)
      .eq(
        "user_id",
        userId
      )
      .eq(
        "active",
        true
      )
      .maybeSingle();



      if (staffError) {

        return res.status(400).json({
          success:false,
          error:staffError.message
        });

      }



      if (!staff) {

        return res.status(403).json({
          success:false,
          error:
          "You are not an active hospital staff member."
        });

      }



      const hospitalId =
        staff.hospital_id;



      const today =
      new Date()
      .toISOString()
      .split("T")[0];



      /* --------------------------------
         GET HOSPITAL NAME
      -------------------------------- */

      const {
        data:hospital,
        error:hospitalError
      }
      =
      await supabaseAdmin
      .from("hospitals")
      .select("name")
      .eq(
        "id",
        hospitalId
      )
      .single();



      if(hospitalError){

        return res.status(400).json({
          success:false,
          error:hospitalError.message
        });

      }




      /* --------------------------------
         GET ALL DEPARTMENTS
      -------------------------------- */

      const {
        data:departments,
        error:departmentError
      }
      =
      await supabaseAdmin
      .from("hospital_departments")
      .select(`
        id,
        name,
        average_minutes
      `)
      .eq(
        "hospital_id",
        hospitalId
      )
      .order(
        "name"
      );



      if(departmentError){

        return res.status(400).json({
          success:false,
          error:departmentError.message
        });

      }



      const board = [];



      /* --------------------------------
         LOAD QUEUE FOR EACH DEPARTMENT
      -------------------------------- */

      for(
        const department of departments || []
      ){



        const {
          data:current
        }
        =
        await supabaseAdmin
        .from("hospital_bookings")
        .select(`
          queue_number,
          called_at
        `)
        .eq(
          "hospital_id",
          hospitalId
        )
        .eq(
          "department_id",
          department.id
        )
        .eq(
          "booking_date",
          today
        )
        .eq(
          "status",
          "called"
        )
        .order(
          "called_at",
          {
            ascending:false
          }
        )
        .limit(1)
        .maybeSingle();





        const {
          data:queues
        }
        =
        await supabaseAdmin
        .from("hospital_bookings")
        .select(`
          queue_number,
          queue_position,
          status,
          priority_level
        `)
        .eq(
          "hospital_id",
          hospitalId
        )
        .eq(
          "department_id",
          department.id
        )
        .eq(
          "booking_date",
          today
        )
        .in(
          "status",
          [
            "waiting",
            "called",
            "checked_in"
          ]
        )
        .order(
          "priority_level",
          {
            ascending:true
          }
        )
        .order(
          "queue_position",
          {
            ascending:false
          }
        );




        const waitingPatients =
        (queues || [])
        .filter(
          item =>
          item.status === "waiting"
        );




        board.push({

          department_id:
            department.id,


          department_name:
            department.name,


          current_serving:
            current?.queue_number ||
            null,


          waiting:
            waitingPatients.length,



          average_wait_minutes:
            waitingPatients.length *
            (
              department.average_minutes ||
              10
            ),



          next_numbers:
            waitingPatients
            .slice(0,5)
            .map(
              item =>
              item.queue_number
            )

        });


      }




      return res.json({

        success:true,


        hospital:
          hospital.name,


        departments:
          board

      });



    } catch(error) {


      console.log(
        "LIVE BOARD ERROR:",
        error
      );


      return res.status(500).json({

        success:false,

        error:error.message

      });

    }

  }
);
/* =========================================================
   DEPARTMENT LIVE BOARD FOR STAFF
========================================================= */

router.get(
  "/department-live-board",
  authenticate,
  async (req, res) => {

    try {

      const userId = req.user.id;

/* ----------------------------------
   CHECK HOSPITAL ADMIN
----------------------------------- */

const {
  data: admin,
  error: adminError,
} = await supabaseAdmin
  .from("hospital_admins")
  .select(`
    hospital_id
  `)
  .eq("user_id", userId)
  .eq("status", "approved")
  .maybeSingle();

if (adminError) {
  return res.status(400).json({
    success: false,
    error: adminError.message,
  });
}

/* ----------------------------------
   CHECK DEPARTMENT STAFF
----------------------------------- */

const {
  data: staff,
  error: staffError,
} = await supabaseAdmin
  .from("hospital_department_staff")
  .select(`
    hospital_id,
    department_id
  `)
  .eq("user_id", userId)
  .eq("active", true)
  .eq("status", "approved")
  .maybeSingle();

if (staffError) {
  return res.status(400).json({
    success: false,
    error: staffError.message,
  });
}

if (!admin && !staff) {
  return res.status(403).json({
    success: false,
    error: "Access denied.",
  });
}

const hospitalId = admin
  ? admin.hospital_id
  : staff.hospital_id;



      const today =
        new Date()
        .toISOString()
        .split("T")[0];



      /*
        ONLY STAFF DEPARTMENT
      */

     let departmentQuery =
  supabaseAdmin
    .from("hospital_departments")
    .select(`
      id,
      name
    `)
    .eq(
      "hospital_id",
      hospitalId
    );

if (!admin) {
  departmentQuery =
    departmentQuery.eq(
      "id",
      staff.department_id
    );
}

const {
  data: departments,
  error: deptError,
} = await departmentQuery.order("name");



      if(deptError){

        return res.status(400).json({

          success:false,

          error:deptError.message,

        });

      }



      const boards = [];



      for(const dept of departments || []){


        /*
          CURRENT SERVING
        */

        let { data: current } =
        await supabaseAdmin
          .from("hospital_bookings")
          .select(`
            queue_number,
            status,
            called_at
          `)
          .eq(
            "hospital_id",
            hospitalId
          )
          .eq(
            "department_id",
            dept.id
          )
          .eq(
            "booking_date",
            today
          )
          .eq(
            "status",
            "called"
          )
          .not(
            "called_at",
            "is",
            null
          )
          .order(
            "called_at",
            {
              ascending:false,
            }
          )
          .limit(1)
          .maybeSingle();



        /*
          FALLBACK CHECKED IN
        */

        if(!current){

          const {
            data:checkedIn
          } =
          await supabaseAdmin
            .from("hospital_bookings")
            .select(`
              queue_number,
              status,
              arrived_at
            `)
            .eq(
              "hospital_id",
              hospitalId
            )
            .eq(
              "department_id",
              dept.id
            )
            .eq(
              "booking_date",
              today
            )
            .eq(
              "status",
              "checked_in"
            )
            .order(
              "arrived_at",
              {
                ascending:false,
              }
            )
            .limit(1)
            .maybeSingle();


          current = checkedIn;

        }



        /*
          QUEUE LIST
        */

        const {
          data: waiting
        } =
        await supabaseAdmin
          .from("hospital_bookings")
          .select(`
            queue_number,
            status,
            queue_position
          `)
          .eq(
            "hospital_id",
            hospitalId
          )
          .eq(
            "department_id",
            dept.id
          )
          .eq(
            "booking_date",
            today
          )
          .in(
            "status",
            [
              "waiting",
              "called",
              "checked_in",
            ]
          )
          .order(
            "queue_position",
            {
              ascending:true,
            }
          );



        const queue =
          waiting || [];



        boards.push({

          department_id:
            dept.id,


          department_name:
            dept.name,


          current_serving:
            current?.queue_number || null,


          current_status:
            current?.status || null,


          waiting_count:
            queue.filter(
              x =>
              x.status === "waiting"
            ).length,


          checked_in_count:
            queue.filter(
              x =>
              x.status === "checked_in"
            ).length,


          next_numbers:
            queue
            .filter(
              x =>
              x.status === "waiting"
            )
            .slice(
              0,
              5
            )
            .map(
              x =>
              x.queue_number
            ),


        });


      }



      return res.json({

        success:true,

        boards,

      });



    }catch(err){


      console.log(err);


      return res.status(500).json({

        success:false,

        error:err.message,

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

      // Current serving (prefer CALLED, otherwise CHECKED_IN)

let { data: currentServing } =
  await supabaseAdmin
    .from("hospital_bookings")
    .select("queue_number,status")
    .eq("hospital_id", booking.hospital_id)
    .eq("department_id", booking.department_id)
    .eq("booking_date", today)
    .eq("status", "called")
    .order("updated_at", {
      ascending: false,
    })
    .limit(1)
    .maybeSingle();

if (!currentServing) {

  const { data: checkedIn } =
    await supabaseAdmin
      .from("hospital_bookings")
      .select("queue_number,status")
      .eq("hospital_id", booking.hospital_id)
      .eq("department_id", booking.department_id)
      .eq("booking_date", today)
      .eq("status", "checked_in")
      .order("updated_at", {
        ascending: false,
      })
      .limit(1)
      .maybeSingle();

  currentServing = checkedIn;

}
      // Next patients waiting
const { data: nextPatients } =
  await supabaseAdmin
    .from("hospital_bookings")
    .select("queue_number")
    .eq("hospital_id", booking.hospital_id)
    .eq("department_id", booking.department_id)
    .eq("booking_date", today)
    .eq("status", "waiting")
    .order("priority_level", {
      ascending: true,
    })
    .order("queue_position", {
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
    .eq("status", "waiting");
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

router.get("/my-queue", authenticate, async (req,res)=>{
try{

const userId = req.user.id;


const {data,error}=await supabaseAdmin
.from("hospital_bookings")
.select(`
  *,
  hospitals(
    id,
    name,
    city,
    district,
    region,
    phone,
    address
  ),
  hospital_departments!hospital_bookings_department_id_fkey(
    id,
    name
  )
`)
.eq("patient_id", userId)
.order("created_at",{ascending:false})
.limit(1)
.maybeSingle();

if(error){
return res.status(400).json({
success:false,
error:error.message
});
}


return res.json({
success:true,
booking:data
});


}catch(err){

return res.status(500).json({
success:false,
error:err.message
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
  async (req, res) => {

    try {

     const userId = req.user.id;

let hospitalId = null;
let departmentId = null;
let role = null;


/*
 CHECK HOSPITAL ADMIN FIRST
*/

const {
  data: hospitalAdmin,
}
=
await supabaseAdmin
.from("hospital_admins")
.select(`
 hospital_id,
 role,
 status
`)
.eq(
 "user_id",
 userId
)
.eq(
 "status",
 "approved"
)
.maybeSingle();


if (hospitalAdmin) {

  hospitalId =
    hospitalAdmin.hospital_id;

  role =
    "hospital_admin";

}


/*
 IF NOT HOSPITAL ADMIN,
 CHECK DEPARTMENT STAFF
*/

if (!hospitalAdmin) {

const {
 data: departmentStaff,
}
=
await supabaseAdmin
.from("hospital_department_staff")
.select(`
 hospital_id,
 department_id,
 status,
 active
`)
.eq(
"user_id",
userId
)
.eq(
"active",
true
)
.eq(
"status",
"approved"
)
.maybeSingle();



if (!departmentStaff) {

return res.status(403).json({
 success:false,
 error:
 "No analytics access"
});

}


hospitalId =
departmentStaff.hospital_id;


departmentId =
departmentStaff.department_id;


role =
"department_staff";

}

      const today =
        req.query.date ||
        new Date()
          .toISOString()
          .split("T")[0];

      /* ------------------------------
         BOOKINGS TODAY
------------------------------ */

let {
  data: bookings,
  error: bookingError,
} =
await supabaseAdmin
  .from("hospital_bookings")
  .select(`
    id,
    patient_record_id,
    status,
    priority,
    created_at,
    called_at,
    arrived_at,
    completed_at,
    department_id,
    hospital_departments!hospital_bookings_department_id_fkey(
      id,
      name
    )
  `)
  .eq("hospital_id", hospitalId)
  .eq("booking_date", today);

if (bookingError) {
  return res.status(400).json({
    success: false,
    error:
      bookingError.message,
  });
}


/*
  Department staff should only
  see their own department.
  Hospital admin sees all
  departments in the hospital.
*/

if (
  role === "department_staff"
) {

  bookings =
    (bookings || []).filter(
      booking =>
        booking.department_id ===
        departmentId
    );

}
      const waiting =
        bookings.filter(
          b =>
            b.status ===
            "waiting"
        ).length;

      const called =
        bookings.filter(
          b =>
            b.status ===
            "called"
        ).length;

      const checkedIn =
        bookings.filter(
          b =>
            b.status ===
            "checked_in"
        ).length;

      const completed =
  bookings.filter(
    b =>
      b.status === "completed" &&
      b.completed_at &&
      b.completed_at.startsWith(today)
  ).length;

      const cancelled =
        bookings.filter(
          b =>
            b.status ===
            "cancelled"
        ).length;

      const noShow =
        bookings.filter(
          b =>
            b.status ===
            "no_show"
        ).length;

      const emergency =
        bookings.filter(
          b =>
            b.priority ===
            "emergency"
        ).length;

      const urgent =
        bookings.filter(
          b =>
            b.priority ===
            "urgent"
        ).length;

      const totalPatients =
        bookings.length;

      /* ------------------------------
         ADMISSIONS
      ------------------------------ */

     const {
  data: admissions,
  error: admissionError,
} = await supabaseAdmin
  .from("hospital_admissions")
  .select(`
    admitted_at,
    discharged_at,
    status
  `)
  .eq("hospital_id", hospitalId)
  .or(
    `admitted_at.gte.${today}T00:00:00,admitted_at.lte.${today}T23:59:59,discharged_at.gte.${today}T00:00:00,discharged_at.lte.${today}T23:59:59`
  );
      if (admissionError) {
        return res.status(400).json({
          success: false,
          error:
            admissionError.message,
        });
      }

      const admittedToday =
       (admissions || []).filter(
          a =>
            a.admitted_at &&
            a.admitted_at.startsWith(
              today
            )
        ).length;

      const dischargedToday =
       (admissions || []).filter(
          a =>
            a.discharged_at &&
            a.discharged_at.startsWith(
              today
            )
        ).length;

      const currentlyAdmitted =
        (admissions || []).filter(
          a =>
            a.status ===
            "admitted"
        ).length;
       /* ------------------------------
   GENDER & AGE
------------------------------ */

const patientRecordIds =
  bookings
    .map(b => b.patient_record_id)
    .filter(Boolean);

let malePatients = 0;
let femalePatients = 0;

let children = 0;
let adults = 0;
let elderly = 0;


if (patientRecordIds.length > 0) {

  const {
    data: patients,
  } =
    await supabaseAdmin
      .from("patient_records")
      .select(`
        id,
        gender,
        date_of_birth
      `)
      .in(
        "id",
        patientRecordIds
      );


  (patients || [])
    .forEach(patient => {

const gender =
  (patient.gender || "").toLowerCase();

if (gender === "male") {
  malePatients++;
}

if (gender === "female") {
  femalePatients++;
}


      if (
        patient.date_of_birth
      ) {

        const age =
Math.floor(
(
new Date(today)
-
new Date(patient.date_of_birth)
)
/
(365.25 * 24 * 60 * 60 * 1000)
);


        if (age < 18) {
          children++;
        }
        else if (age < 60) {
          adults++;
        }
        else {
          elderly++;
        }

      }

    });

}
/* ------------------------------
   AVERAGE WAITING TIME
------------------------------ */

let waitingTotal = 0;
let waitingCount = 0;

bookings.forEach((booking) => {

  if (
    booking.called_at &&
    booking.created_at
  ) {

    const minutes =
      (
        new Date(
          booking.called_at
        ) -
        new Date(
          booking.created_at
        )
      ) /
      60000;

    waitingTotal += minutes;
    waitingCount++;

  }

});

const averageWaitingTime =
  waitingCount > 0
    ? Math.round(
        waitingTotal /
          waitingCount
      )
    : 0;

/* ------------------------------
   AVERAGE CONSULTATION TIME
------------------------------ */

let consultationTotal = 0;
let consultationCount = 0;

bookings.forEach((booking) => {

  if (
    booking.arrived_at &&
    booking.completed_at &&
    booking.completed_at.startsWith(today)
  ) {

    const minutes =
      (
        new Date(
          booking.completed_at
        ) -
        new Date(
          booking.arrived_at
        )
      ) /
      60000;

    consultationTotal += minutes;
    consultationCount++;

  }

});
const averageConsultationTime =
  consultationCount > 0
    ? Math.round(
        consultationTotal /
          consultationCount
      )
    : 0;
    /* ------------------------------
   RATES
------------------------------ */

const cancellationRate =
  totalPatients
    ? Math.round(
        (cancelled /
          totalPatients) *
          100
      )
    : 0;

const noShowRate =
  totalPatients
    ? Math.round(
        (noShow /
          totalPatients) *
          100
      )
    : 0;

/* ------------------------------
   DEPARTMENT SUMMARY
------------------------------ */

const departmentMap = {};

bookings.forEach((booking) => {

  const id =
    booking.department_id;

  const name =
    booking
      .hospital_departments
      ?.name ||
    "Unknown";

  if (!departmentMap[id]) {

    departmentMap[id] = {
      department_id: id,
      department_name: name,
      patients: 0,
      waiting: 0,
      called: 0,
      checked_in: 0,
      completed: 0,
    };

  }

  departmentMap[id]
    .patients++;

  if (
    booking.status ===
    "waiting"
  ) {
    departmentMap[id]
      .waiting++;
  }

  if (
    booking.status ===
    "called"
  ) {
    departmentMap[id]
      .called++;
  }

  if (
    booking.status ===
    "checked_in"
  ) {
    departmentMap[id]
      .checked_in++;
  }

  if (
    booking.status ===
    "completed"
  ) {
    departmentMap[id]
      .completed++;
  }

});

const departments =
  Object.values(
    departmentMap
  );
/* ------------------------------
   BUSIEST DEPARTMENT
------------------------------ */

let busiestDepartment = null;
let busiestDepartmentCount = 0;

departments.forEach((dept) => {

  if (
    dept.patients >
    busiestDepartmentCount
  ) {

    busiestDepartment =
      dept.department_name;

    busiestDepartmentCount =
      dept.patients;

  }

});
/* ------------------------------
   HOURLY ARRIVALS
------------------------------ */

const hourlyMap = {};

bookings.forEach((booking) => {

  const bookingDate =
  booking.created_at.split("T")[0];

if (bookingDate !== today) return;

const hour =
  new Date(
    booking.created_at
  ).getHours();

  const label =
    `${hour
      .toString()
      .padStart(2, "0")}:00`;

  hourlyMap[label] =
    (hourlyMap[label] || 0) +
    1;

});

const hourly =
  Object.keys(hourlyMap)
    .sort()
    .map((hour) => ({
      hour,
      patients:
        hourlyMap[hour],
    }));
/* ------------------------------
   PEAK HOUR
------------------------------ */

let peakHour = null;
let peakHourCount = 0;

hourly.forEach((item) => {

  if (
    item.patients >
    peakHourCount
  ) {

    peakHour =
      item.hour;

    peakHourCount =
      item.patients;

  }

})
/* ------------------------------
   RESPONSE
------------------------------ */

return res.json({
  success:true,

 access: {
  role,

  hospital_id: hospitalId,

  department_id:
    role === "department_staff"
      ? departmentId
      : null,
},
  analytics:{

  date: today,

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

  emergency,

  urgent,

  admitted:
    admittedToday,

  discharged:
    dischargedToday,

  currently_admitted:
    currentlyAdmitted,

  average_wait_minutes:
    averageWaitingTime,

  average_consultation_minutes:
    averageConsultationTime,

  busiest_department:
    busiestDepartment,

  busiest_department_count:
    busiestDepartmentCount,

  peak_hour:
    peakHour,

  cancellation_rate:
    cancellationRate,

  no_show_rate:
    noShowRate,

  male_patients:
    malePatients,

  female_patients:
    femalePatients,

  children,

  adults,

  elderly,

  departments,

  hourly,

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
   GET STAFF PROFILE
========================================================= */

router.get(
  "/staff-profile",
  authenticate,
  hospitalDepartmentStaffAuth,
  async (req,res)=>{

    try {

      const staffId =
        req.staff.id;


      const {
        data:staff,
        error
      } =
      await supabaseAdmin
      .from("hospital_department_staff")
      .select(`
        id,
        full_name,
        role,
        department_id,
        hospital_id,

        hospital_departments(
          name
        ),

        hospitals(
          name
        )

      `)
      .eq(
        "id",
        staffId
      )
      .single();



      if(error){

        return res.status(400).json({
          success:false,
          error:error.message
        });

      }



      return res.json({

        success:true,

        staff:{
          id:staff.id,

          name:
          staff.full_name,

          role:
          staff.role,

          department:
          staff.hospital_departments?.name,

          hospital:
          staff.hospitals?.name
        }

      });



    }catch(err){

      console.log(err);

      res.status(500).json({
        success:false,
        error:err.message
      });

    }

  }
);

/* =========================================================
   TODAY'S DEPARTMENT QUEUE
   Department Staff Only
========================================================= */

router.get(
  "/queue",
  authenticate,
  async (req, res) => {

    try {

      const userId = req.user.id;

      /* -----------------------------
         GET STAFF
      ----------------------------- */

      const {
        data: staff,
        error: staffError,
      } =
      await supabaseAdmin
        .from("hospital_department_staff")
        .select(`
          hospital_id,
          department_id
        `)
        .eq("user_id", userId)
        .eq("active", true)
        .maybeSingle();

      if (staffError) {

        return res.status(500).json({
          success: false,
          error: staffError.message,
        });

      }

      if (!staff) {

        return res.status(403).json({
          success: false,
          error:
            "You are not an active department staff member.",
        });

      }

      const hospitalId =
        staff.hospital_id;

      const departmentId =
        staff.department_id;

      const today =
        new Date()
          .toISOString()
          .split("T")[0];

      /* -----------------------------
         LOAD QUEUE
      ----------------------------- */

      const {
        data,
        error,
      } =
      await supabaseAdmin
        .from("hospital_bookings")
        .select(`
          *,
          hospital_departments!hospital_bookings_department_id_fkey(
            id,
            name
          ),
          patient_records(
            id,
            full_name,
            phone,
            gender,
            date_of_birth
          ),
          next_department:hospital_departments!hospital_bookings_next_department_id_fkey(
            id,
            name
          )
        `)
        .eq("hospital_id", hospitalId)
        .eq("department_id", departmentId)
        .eq("booking_date", today)
        .order("priority_level", {
          ascending: true,
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

      const queue =
        (data || []).map((booking) => ({

          ...booking,

          patient_name:
            booking.patient_records?.full_name ||
            "Unknown Patient",

          patient_phone:
            booking.patient_records?.phone || null,

          patient_gender:
            booking.patient_records?.gender || null,

          patient_dob:
            booking.patient_records?.date_of_birth || null,

          booking_source:
            booking.patient_record_id
              ? "online"
              : "walk_in",

          checked_in:
            booking.checked_in === true,

          next_department_name:
            booking.next_department?.name || null,

        }));

      return res.json({

        success: true,

        queue,

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
   LIVE DEPARTMENT DASHBOARD
========================================================= */

router.post(
  "/department-dashboard",
  authenticate,
  departmentStaffAuth,
  async (req, res) => {

    try {

      const hospitalId =
        req.departmentStaff.hospital_id;

      const staffDepartmentId =
        req.departmentStaff.department_id;

const department_id =
req.departmentStaff.department_id;



      if (!department_id) {

        return res.status(400).json({
          error:
          "department_id is required",
        });

      }


      // Staff can only view their own department

      if (
        department_id !== staffDepartmentId
      ) {

        return res.status(403).json({
          error:
          "You cannot access another department",
        });

      }



      const {
        data: department,
        error: departmentError,
      } =
      await supabaseAdmin
      .from("hospital_departments")
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



      if(
        departmentError ||
        !department
      ){

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
      }
      =
      await supabaseAdmin
      .from("hospital_bookings")
      .select(`
        id,
        queue_number,
        booking_code,
        patient_id,
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
          ascending:true
        }
      )
      .order(
        "created_at",
        {
          ascending:true
        }
      );



      if(bookingError){

        return res.status(400).json({
          error:
          bookingError.message
        });

      }



      /*
        LOAD WALK-IN PATIENTS
      */

      const patientRecordIds =
      bookings
      .map(
        b=>b.patient_record_id
      )
      .filter(Boolean);



      let patientMap = {};



      if(
        patientRecordIds.length > 0
      ){

        const {
          data:patients
        }
        =
        await supabaseAdmin
        .from("patient_records")
        .select(`
          id,
          full_name
        `)
        .in(
          "id",
          patientRecordIds
        );



        if(patients){

          patientMap =
          patients.reduce(
            (acc,item)=>{

              acc[item.id] =
              item.full_name;

              return acc;

            },
            {}
          );

        }

      }




      /*
        LOAD ONLINE NASARA USERS
      */


      const userIds =
      bookings
      .map(
        b=>b.patient_id
      )
      .filter(Boolean);



      let userMap = {};



      if(
        userIds.length > 0
      ){

        const {
          data:users
        }
        =
        await supabaseAdmin
        .from("profiles")
        .select(`
          id,
          full_name
        `)
        .in(
          "id",
          userIds
        );



        if(users){

          userMap =
          users.reduce(
            (acc,item)=>{

              acc[item.id] =
              item.full_name;

              return acc;

            },
            {}
          );

        }

      }





      const statistics = {

        waiting:
        bookings.filter(
          b=>b.status==="waiting"
        ).length,


        called:
        bookings.filter(
          b=>b.status==="called"
        ).length,


        checked_in:
        bookings.filter(
          b=>b.status==="checked_in"
        ).length,


        completed:
        bookings.filter(
          b=>b.status==="completed"
        ).length,


        emergency:
        bookings.filter(
          b=>b.priority==="emergency"
        ).length,


        urgent:
        bookings.filter(
          b=>b.priority==="urgent"
        ).length,


        total_today:
        bookings.length,

      };





      const utilisation =
      Math.min(
        100,
        Math.round(
          (
            statistics.waiting +
            statistics.called +
            statistics.checked_in
          )
          /
          Math.max(
            statistics.total_today,
            1
          )
          *
          100
        )
      );



      const average_wait =
      statistics.waiting *
      (
        department.average_minutes || 10
      );



      const currentPatient =
      bookings.find(
        b=>
        b.status==="called"
      ) || null;





      const queue =
      bookings.map(
        booking=>({

          booking_id:
          booking.id,


          queue_number:
          booking.queue_number,


          booking_code:
          booking.booking_code,


          patient_name:
          booking.patient_id
          ?
          userMap[
            booking.patient_id
          ] || "Online Patient"
          :
          patientMap[
            booking.patient_record_id
          ] || "Walk-in Patient",


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

        department:{

          id:
          department.id,

          name:
          department.name,

          average_minutes:
          department.average_minutes,

        },


        statistics,


        utilisation,


        average_wait,


        current_patient:
        currentPatient
        ?
        {

          booking_id:
          currentPatient.id,


          queue_number:
          currentPatient.queue_number,


          booking_code:
          currentPatient.booking_code,


          patient_name:
          currentPatient.patient_id
          ?
          userMap[
            currentPatient.patient_id
          ]
          :
          patientMap[
            currentPatient.patient_record_id
          ],


          priority:
          currentPatient.priority,


          status:
          currentPatient.status,


          condition:
          currentPatient.condition,

        }
        :
        null,


        queue,

      });



    } catch(err){

      console.error(err);

      return res.status(500).json({
        error:
        err.message
      });

    }

  }
);

/* =========================================================
   DEPARTMENT UTILISATION
   (HOSPITAL ADMIN + DEPARTMENT STAFF)
========================================================= */

router.get(
  "/department-utilisation",
  authenticate,
  async (req, res) => {

    try {

      const userId = req.user.id;

      let hospitalId = null;
      let departmentId = null;
      let role = null;

      /* -----------------------------
         CHECK HOSPITAL ADMIN
      ----------------------------- */

      const {
        data: hospitalAdmin,
        error: adminError,
      } =
      await supabaseAdmin
        .from("hospital_admins")
        .select(`
          hospital_id,
          status
        `)
        .eq(
          "user_id",
          userId
        )
        .eq(
          "status",
          "approved"
        )
        .maybeSingle();

      if (adminError) {

        return res.status(400).json({

          success: false,

          error:
            adminError.message,

        });

      }

      if (hospitalAdmin) {

        hospitalId =
          hospitalAdmin.hospital_id;

        role =
          "hospital_admin";

      }

      /* -----------------------------
         CHECK DEPARTMENT STAFF
      ----------------------------- */

      if (!hospitalAdmin) {

        const {
          data: staff,
          error: staffError,
        } =
        await supabaseAdmin
          .from("hospital_department_staff")
          .select(`
            hospital_id,
            department_id,
            status,
            active
          `)
          .eq(
            "user_id",
            userId
          )
          .eq(
            "status",
            "approved"
          )
          .eq(
            "active",
            true
          )
          .maybeSingle();

        if (staffError) {

          return res.status(400).json({

            success: false,

            error:
              staffError.message,

          });

        }

        if (!staff) {

          return res.status(403).json({

            success: false,

            error:
              "You do not have access.",

          });

        }

        hospitalId =
          staff.hospital_id;

        departmentId =
          staff.department_id;

        role =
          "department_staff";

      }

      const today =
        new Date()
          .toISOString()
          .split("T")[0];

      /* -----------------------------
         LOAD DEPARTMENTS
      ----------------------------- */

      let departments = [];

      if (
        role ===
        "hospital_admin"
      ) {

        const {
          data,
          error,
        } =
        await supabaseAdmin
          .from("hospital_departments")
          .select(`
            id,
            name,
            average_minutes
          `)
          .eq(
            "hospital_id",
            hospitalId
          )
          .eq(
            "is_active",
            true
          )
          .order(
            "name",
            {
              ascending: true,
            }
          );

        if (error) {

          return res.status(400).json({

            success: false,

            error:
              error.message,

          });

        }

        departments =
          data || [];

      } else {

        const {
          data,
          error,
        } =
        await supabaseAdmin
          .from("hospital_departments")
          .select(`
            id,
            name,
            average_minutes
          `)
          .eq(
            "id",
            departmentId
          )
          .eq(
            "hospital_id",
            hospitalId
          )
          .eq(
            "is_active",
            true
          )
          .single();

        if (
          error ||
          !data
        ) {

          return res.status(404).json({

            success: false,

            error:
              "Department not found",

          });

        }

        departments = [
          data,
        ];

      }
      /* -----------------------------
         LOAD TODAY BOOKINGS
      ----------------------------- */

      const {
        data: bookings,
        error: bookingError,
      } =
      await supabaseAdmin
        .from("hospital_bookings")
        .select(`
          department_id,
          status,
          priority
        `)
        .eq(
          "hospital_id",
          hospitalId
        )
        .eq(
          "booking_date",
          today
        );

      if (bookingError) {

        return res.status(400).json({

          success: false,

          error:
            bookingError.message,

        });

      }

      const allBookings =
        bookings || [];

      /* -----------------------------
         BUILD DEPARTMENT STATISTICS
      ----------------------------- */

      const departmentStatistics =
        departments.map(
          (department) => {

            const departmentBookings =
              allBookings.filter(
                (booking) =>
                  booking.department_id ===
                  department.id
              );

            const total =
              departmentBookings.length;

            const waiting =
              departmentBookings.filter(
                b =>
                  b.status ===
                  "waiting"
              ).length;

            const called =
              departmentBookings.filter(
                b =>
                  b.status ===
                  "called"
              ).length;

            const checkedIn =
              departmentBookings.filter(
                b =>
                  b.status ===
                  "checked_in"
              ).length;

            const completed =
              departmentBookings.filter(
                b =>
                  b.status ===
                  "completed"
              ).length;

            const emergency =
              departmentBookings.filter(
                b =>
                  b.priority ===
                  "emergency"
              ).length;

            const urgent =
              departmentBookings.filter(
                b =>
                  b.priority ===
                  "urgent"
              ).length;

            const utilisation =
              total > 0
                ? Math.min(
                    100,
                    Math.round(
                      (
                        departmentBookings.filter(
                          b =>
                            b.status !==
                            "completed"
                        ).length /
                        total
                      ) * 100
                    )
                  )
                : 0;

            return {

              department_id:
                department.id,

              department_name:
                department.name,

              average_minutes:
                department.average_minutes,

              waiting,

              called,

              checked_in:
                checkedIn,

              completed,

              emergency,

              urgent,

              total,

              utilisation,

            };

          }
        );
      /* -----------------------------
         RESPONSE
      ----------------------------- */

      return res.json({

        success: true,

        role,

        hospital_id:
          hospitalId,

        department_id:
          role === "department_staff"
            ? departmentId
            : null,

        total_departments:
          departmentStatistics.length,

        departments:
          departmentStatistics,

      });

    } catch (err) {

      console.log(err);

      return res.status(500).json({

        success: false,

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
   HOSPITAL LIVE NOTIFICATIONS FOR STAFF
========================================================= */

router.get(
  "/live-notifications",
  authenticate,
  async (req, res) => {

    try {

      const userId = req.user.id;


      /*
        FIND STAFF ASSIGNMENT
      */

      const {
        data: staff,
        error: staffError,
      } =
        await supabaseAdmin
          .from("hospital_department_staff")
          .select(`
            id,
            hospital_id,
            department_id,
            role,
            status,
            active
          `)
          .eq(
            "user_id",
            userId
          )
          .eq(
            "active",
            true
          )
          .eq(
            "status",
            "approved"
          )
          .maybeSingle();


      if (staffError) {

        return res.status(400).json({

          success:false,

          error:staffError.message,

        });

      }


      if (!staff) {

        return res.status(403).json({

          success:false,

          error:
          "You are not approved as department staff."

        });

      }



      /*
        GET HOSPITAL NOTIFICATIONS
      */

      const {
        data,
        error
      } =
      await supabaseAdmin
        .from(
          "hospital_notifications"
        )
        .select("*")
        .eq(
          "hospital_id",
          staff.hospital_id
        )
        .order(
          "created_at",
          {
            ascending:false,
          }
        )
        .limit(50);



      if(error){

        return res.status(400).json({

          success:false,

          error:error.message,

        });

      }



      return res.json({

        success:true,

        notifications:data || [],

        staff:{
          hospital_id:
          staff.hospital_id,

          department_id:
          staff.department_id,

          role:
          staff.role,
        }

      });


    } catch(err) {


      console.log(err);


      return res.status(500).json({

        success:false,

        error:err.message,

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
         { name: "Billing", average_minutes: 5 },
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
   GET HOSPITAL DEPARTMENTS FOR STAFF
========================================================= */

router.get(
  "/departments",
  authenticate,
  hospitalDepartmentStaffAuth,
  async (req, res) => {

    try {

      const hospitalId =
        req.staff.hospital_id;


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

      console.log(
        "Get departments error:",
        err
      );

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
 async (req, res) => {
  try {

  const {
    data: staff,
    error: staffError,
  } = await supabaseAdmin
    .from("hospital_department_staff")
    .select(`
      id,
      hospital_id,
      department_id
    `)
    .eq("user_id", req.user.id)
    .eq("active", true)
    .maybeSingle();

  if (staffError) {
    return res.status(500).json({
      success: false,
      error: staffError.message,
    });
  }

  if (!staff) {
    return res.status(403).json({
      success: false,
      error: "Department staff account not found.",
    });
  }

  const hospitalId = staff.hospital_id;
  const departmentId = staff.department_id;

  const { booking_id, status } = req.body;
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
.eq("department_id", departmentId)
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
.eq("hospital_id", hospitalId)
.eq("department_id", departmentId)
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


const {
  data: department
}
=
await supabaseAdmin
.from("hospital_departments")
.select("name")
.eq(
  "id",
  booking.department_id
)
.maybeSingle();



const departmentName =
department?.name || "Department";



/*
====================================
BUILD VOICE SEQUENCE
====================================
*/

const voices =
await buildVoiceSequence(
  booking.hospital_id,
  booking.department_id
);

// 3. Insert single voice queue with multiple languages

const {
  error: voiceError
}
=
await supabaseAdmin
.from("hospital_voice_queue")
.insert({

  hospital_id:
    booking.hospital_id,


  booking_id:
    booking.id,


  department_id:
    booking.department_id,


  patient_id:
    booking.patient_id,


  queue_number:
    booking.queue_number,


  message:
    `${departmentName} Queue Number ${booking.queue_number}`,


  voices,


  priority:
    booking.priority_level || 3,


  played:false,

});


if(voiceError){

  console.log(
    "VOICE QUEUE INSERT ERROR",
    voiceError
  );

}


  
/* --------------------------------
   NOTIFY THE NEXT PATIENT
-------------------------------- */
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
  async (req, res) => {

    try {

     const {
  data: staff,
  error: staffError,
} = await supabaseAdmin
  .from("hospital_department_staff")
  .select(`
    hospital_id,
    department_id
  `)
  .eq("user_id", req.user.id)
  .eq("active", true)
  .maybeSingle();

if (staffError) {
  return res.status(500).json({
    success: false,
    error: staffError.message,
  });
}

if (!staff) {
  return res.status(403).json({
    success: false,
    error: "Department staff account not found.",
  });
}

const hospitalId = staff.hospital_id;
const departmentId = staff.department_id

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
.eq("department_id", departmentId)
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
.eq("hospital_id", hospitalId)
.eq("department_id", departmentId)
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
async (req, res) => {
  try {
    const { booking_code } = req.body;
    const {
  data: staff,
  error: staffError,
} = await supabaseAdmin
  .from("hospital_department_staff")
  .select(`
    hospital_id,
    department_id
  `)
  .eq("user_id", req.user.id)
  .eq("active", true)
  .maybeSingle();

if (staffError) {
  return res.status(500).json({
    success: false,
    error: staffError.message,
  });
}

if (!staff) {
  return res.status(403).json({
    success: false,
    error: "Department staff account not found.",
  });
}

const hospitalId = staff.hospital_id;
const departmentId = staff.department_id;
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
.eq("department_id", departmentId)
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
.eq("hospital_id", hospitalId)
.eq("department_id", departmentId)
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
   HOSPITAL PROFILE
========================================================= */

router.get(
  "/profile",
  authenticate,
  hospitalAdminAuth,
  async (req, res) => {

    try {

      const hospitalId =
        req.hospitalAdmin.hospital_id;

      const {
        data,
        error,
      } =
      await supabaseAdmin
        .from("hospitals")
        .select(`
          id,
          name,
          hospital_type,
          ownership,
          email,
          phone,
          website,
          digital_address,
          gps_address,
          address,
          region,
          district,
          city,
          emergency_phone,
          logo_url,
          cover_image_url,
          profile_completed,
          created_at
        `)
        .eq("id", hospitalId)
        .single();

      if (error) {

        return res.status(400).json({
          success:false,
          error:error.message,
        });

      }

      return res.json({

        success:true,

        profile_completed:
          data.profile_completed === true,

        hospital:data,

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
      for (const item of working_hours) {

  if (
    !item.is_closed &&
    !item.is_24_hours
  ) {

    if (
      !item.opening_time ||
      !item.closing_time
    ) {

      return res.status(400).json({

        success: false,

        error:
          `Opening and closing times are required for day ${item.day_of_week}.`,

      });

    }

  }

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
   HOSPITAL DEPARTMENT STAFF AUTH
========================================================= */
async function hospitalDepartmentStaffAuth(
  req,
  res,
  next
) {
  try {
    const userId = req.user.id;

    const { data, error } =
      await supabaseAdmin
        .from("hospital_department_staff")
        .select("*")
        .eq("user_id", userId)
        .eq("active", true)
        .eq("status", "approved")
        .maybeSingle();

    if (error || !data) {
      return res.status(403).json({
        success: false,
        error: "Department staff access denied.",
      });
    }

    req.staff = data;

    next();

  } catch (err) {

    return res.status(500).json({
      success: false,
      error: err.message,
    });

  }
}

/* =========================================================
   CREATE DEPARTMENT STAFF
========================================================= */

router.post(
  "/create-department-staff",
  authenticate,
  hospitalAdminAuth,
  async (req, res) => {

    try {

      const hospitalId =
        req.hospitalAdmin.hospital_id;

      const adminUserId =
        req.user.id;

      const {

        email,
        password,
        full_name,
        department_id,
        role,

      } = req.body;

      if (
        !email ||
        !password ||
        !full_name ||
        !department_id ||
        !role
      ) {

        return res.status(400).json({

          success: false,

          error:
            "email, password, full_name, department_id and role are required.",

        });

      }

      // Make sure department belongs to this hospital

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

          error: "Department not found.",

        });

      }

      let userId;

      let existingUser = false;

      // ==========================================
      // CREATE AUTH USER
      // ==========================================

      const {

        data: authData,

        error: authError,

      } =
      await supabaseAdmin
      .auth
      .admin
      .createUser({

        email,

        password,

        email_confirm: true,

      });

      if (authData?.user) {

        userId =
          authData.user.id;

      }
      // ==========================================
      // EXISTING AUTH USER
      // ==========================================

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

            page: 1,

            perPage: 1000,

          });

          if (error) {

            return res.status(400).json({

              success: false,

              error: error.message,

            });

          }

          const found =
            data.users.find(
              (u) =>
                u.email?.toLowerCase() ===
                email.toLowerCase()
            );

          if (!found) {

            return res.status(400).json({

              success: false,

              error: "Existing user not found.",

            });

          }

          userId = found.id;

        } else {

          return res.status(400).json({

            success: false,

            error: authError.message,

          });

        }

      }

      if (!userId) {

        return res.status(400).json({

          success: false,

          error: "Unable to create staff user.",

        });

      }

      // ==========================================
      // PREVENT DUPLICATE STAFF
      // ==========================================

      const {

        data: existingStaff,

      } =
      await supabaseAdmin
      .from("hospital_department_staff")
      .select("id")
      .eq("user_id", userId)
      .maybeSingle();

      if (existingStaff) {

        return res.status(400).json({

          success: false,

          error: "User is already registered as hospital staff.",

        });

      }

      // ==========================================
      // INSERT STAFF
      // ==========================================

      const {

        error: insertError,

      } =
      await supabaseAdmin
      .from("hospital_department_staff")
      .insert({

        user_id: userId,

        hospital_id: hospitalId,

        department_id,

        full_name,

        email,

        role,

        status: "approved",

        active: true,

        created_by: adminUserId,

      });

      if (insertError) {

        return res.status(400).json({

          success: false,

          error: insertError.message,

        });

      }

      return res.json({

        success: true,

        existing_user: existingUser,

        user_id: userId,

        message:
          "Department staff created successfully.",

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
   TRANSFER PATIENT TO ANOTHER DEPARTMENT
========================================================= */

router.post(
  "/transfer-patient",
  authenticate,
  departmentStaffAuth,
  async (req, res) => {
    try {

     const hospitalId =
  req.departmentStaff.hospital_id;

const staffId =
  req.user.id;

      const {
        booking_id,
        next_department_id,
        note,
      } = req.body;

      if (!booking_id || !next_department_id) {
        return res.status(400).json({
          success: false,
          error:
            "booking_id and next_department_id are required.",
        });
      }

      /* ----------------------------------
         CURRENT BOOKING
      ---------------------------------- */

      const {
        data: booking,
        error: bookingError,
      } = await supabaseAdmin
        .from("hospital_bookings")
        .select("*")
        .eq("id", booking_id)
        .eq("hospital_id", hospitalId)
        .maybeSingle();

      if (bookingError || !booking) {
        return res.status(404).json({
          success: false,
          error: "Booking not found.",
        });
      }

      /* ----------------------------------
         DESTINATION DEPARTMENT
      ---------------------------------- */

      const {
        data: department,
      } = await supabaseAdmin
        .from("hospital_departments")
        .select("*")
        .eq("id", next_department_id)
        .eq("hospital_id", hospitalId)
        .maybeSingle();

      if (!department) {
        return res.status(404).json({
          success: false,
          error:
            "Destination department not found.",
        });
      }

      /* ----------------------------------
         NEXT QUEUE NUMBER
      ---------------------------------- */

      const { count } =
        await supabaseAdmin
          .from("hospital_bookings")
          .select("*", {
            count: "exact",
            head: true,
          })
          .eq("hospital_id", hospitalId)
          .eq(
            "department_id",
            next_department_id
          )
          .eq(
            "booking_date",
            booking.booking_date
          );

      const queueNumber = String(
        (count || 0) + 1
      ).padStart(3, "0");

      /* ----------------------------------
         UPDATE BOOKING
      ---------------------------------- */

      const {
        data,
        error,
      } = await supabaseAdmin
        .from("hospital_bookings")
        .update({

          previous_department_id:
            booking.department_id,

          department_id:
            next_department_id,

          department:
            department.name,

          queue_number:
            queueNumber,

          queue_position:
            (count || 0) + 1,

          current_stage:
            "waiting",

          status:
            "waiting",

          checked_in:
            false,

          called_at:
            null,

          arrived_at:
            null,

          completed_at:
            null,

          transferred_at:
            new Date().toISOString(),

          transferred_by:
            staffId,

          transfer_note:
            note || null,

        })
        .eq("id", booking.id)
        .select()
        .single();

      if (error) {
        return res.status(400).json({
          success: false,
          error: error.message,
        });
      }
      /* ----------------------------------
         CREATE TRANSFER HISTORY
      ---------------------------------- */

      const {
        error: historyError,
      } = await supabaseAdmin
        .from("hospital_patient_transfers")
        .insert({

          booking_id: booking.id,

          patient_id: booking.patient_id,

          hospital_id: hospitalId,

          from_department_id:
            booking.department_id,

          to_department_id:
            next_department_id,

          transferred_by:
            staffId,

          note:
            note || null,

          transferred_at:
            new Date().toISOString(),

        });

      if (historyError) {

        console.log(
          "Transfer History:",
          historyError.message
        );

      }

      /* ----------------------------------
         CREATE NOTIFICATION
      ---------------------------------- */

      await supabaseAdmin
        .from("hospital_notifications")
        .insert({

          hospital_id:
            hospitalId,

          title:
            "Patient Transfer",

          message:
            `Patient ${booking.queue_number} has been transferred to ${department.name}.`,

          type:
            "patient_transfer",

          booking_id:
            booking.id,

          department_id:
            next_department_id,

          created_at:
            new Date().toISOString(),

        });

      /* ----------------------------------
         RESPONSE
      ---------------------------------- */

      return res.json({

        success: true,

        message:
          "Patient transferred successfully.",

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
   CALL NEXT PATIENT
========================================================= */

router.post(
  "/call-next-patient",
  authenticate,
  hospitalDepartmentStaffAuth,
  async (req, res) => {

    try {

      const hospitalId =
        req.staff.hospital_id;

      const departmentId =
        req.staff.department_id;

      const staffId =
        req.user.id;

      const today =
        new Date()
          .toISOString()
          .split("T")[0];

      /* -----------------------------
         FIND NEXT WAITING PATIENT
      ----------------------------- */

      const {
        data: booking,
        error: bookingError,
      } =
      await supabaseAdmin
      .from("hospital_bookings")
      .select("*")
      .eq("hospital_id", hospitalId)
      .eq("department_id", departmentId)
      .eq("booking_date", today)
      .eq("status", "waiting")
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
      )
      .limit(1)
      .maybeSingle();

      if (bookingError) {

        return res.status(400).json({
          success:false,
          error:bookingError.message,
        });

      }

      if (!booking) {

        return res.status(404).json({
          success:false,
          error:"No waiting patient.",
        });

      }

      /* -----------------------------
         MARK AS CALLED
      ----------------------------- */

      const {
        data,
        error,
      } =
      await supabaseAdmin
      .from("hospital_bookings")
      .update({

        status:"called",

        current_stage:"called",

        called_at:
          new Date().toISOString(),

        called_by:
          staffId,

      })
      .eq("id", booking.id)
      .select()
      .single();

      if (error) {

        return res.status(400).json({
          success:false,
          error:error.message,
        });

      }
  /* --------------------------------
   CREATE MULTI-LANGUAGE VOICE LIST
-------------------------------- */

const voices =
await buildVoiceSequence(
  hospitalId,
  departmentId
);


/* --------------------------------
   SAVE SINGLE VOICE ANNOUNCEMENT
-------------------------------- */

const { error: voiceError } =
await supabaseAdmin
.from("hospital_voice_queue")
.insert({

  hospital_id: hospitalId,

  department_id: departmentId,

  booking_id: booking.id,

  patient_id: booking.patient_id,

  queue_number: booking.queue_number,

  message:
    `${req.staff.department_name} Queue Number ${booking.queue_number}`,

  voices,

  priority:
    booking.priority_level || 3,

  played:false

});


if(voiceError){

  console.log(
    "VOICE QUEUE INSERT ERROR",
    voiceError
  );

}

      /* --------------------------------
         CREATE PATIENT NOTIFICATION
      -------------------------------- */

      if (booking.patient_id) {

        await supabaseAdmin
        .from("hospital_notifications")
        .insert({

          hospital_id:
            hospitalId,

          patient_id:
            booking.patient_id,

          booking_id:
            booking.id,

          title:
            "You are being called",

          message:
            `Queue ${booking.queue_number}, please proceed to ${req.staff.department_name}.`,

          type:
            "called",

          read:
            false,

        });

      }

      /* --------------------------------
         RESPONSE
      -------------------------------- */

      return res.json({

        success: true,

        booking: data,

        voice: {

          queue_number:
            booking.queue_number,

          message:
            `Queue ${booking.queue_number}, please proceed to ${req.staff.department_name}.`

        }

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
  "/patient-journey/:booking_id",
  authenticate,
  hospitalDepartmentStaffAuth,
  async (req, res) => {

    try {

      const hospitalId =
        req.staff.hospital_id;

      const bookingId =
        req.params.booking_id;

      const {
        data,
        error,
      } =
      await supabaseAdmin
      .from("hospital_patient_transfers")
      .select(`
        id,
        note,
        transferred_at,

        from_department:hospital_departments!hospital_patient_transfers_from_department_id_fkey(
          id,
          name
        ),

        to_department:hospital_departments!hospital_patient_transfers_to_department_id_fkey(
          id,
          name
        )

      `)
      .eq(
        "hospital_id",
        hospitalId
      )
      .eq(
        "booking_id",
        bookingId
      )
      .order(
        "transferred_at",
        {
          ascending: true,
        }
      );

      if (error) {

        return res.status(400).json({

          success:false,

          error:error.message,

        });

      }

      return res.json({

        success:true,

        journey:data,

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
  departmentStaffAuth,
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
   ONLINE PATIENT JOIN QUEUE (NASARA AUTH USERS ONLY)
========================================================= */

router.post(
  "/online-join-queue",
  authenticate,
  async (req, res) => {
    try {

      const {
        hospital_id,
        department_id,
        condition,
      } = req.body;


      const patientId = req.user.id;


      if (!hospital_id || !department_id) {
        return res.status(400).json({
          success: false,
          error:
            "hospital_id and department_id are required.",
        });
      }


      /* ----------------------------------
         VERIFY DEPARTMENT
      ---------------------------------- */

      const {
        data: department,
        error: departmentError,
      } =
      await supabaseAdmin
        .from("hospital_departments")
        .select(`
          id,
          name
        `)
        .eq("id", department_id)
        .eq("hospital_id", hospital_id)
        .eq("is_active", true)
        .maybeSingle();


      if (departmentError) {
        return res.status(400).json({
          success:false,
          error: departmentError.message,
        });
      }


      if (!department) {
        return res.status(404).json({
          success:false,
          error:"Department not found.",
        });
      }



      /* ----------------------------------
         TODAY DATE
      ---------------------------------- */

      const today =
        new Date()
        .toISOString()
        .split("T")[0];



      /* ----------------------------------
         PREVENT DUPLICATE ONLINE BOOKING
      ---------------------------------- */

      const {
        data: existingBooking,
      } =
      await supabaseAdmin
        .from("hospital_bookings")
        .select(`
          id,
          queue_number,
          status
        `)
        .eq("patient_id", patientId)
        .eq("hospital_id", hospital_id)
        .eq("booking_date", today)
        .in("status",[
          "waiting",
          "called",
          "checked_in"
        ])
        .maybeSingle();



      if(existingBooking){

        return res.status(400).json({
          success:false,
          error:
          "You already have an active queue today.",
          booking: existingBooking,
        });

      }




      /* ----------------------------------
         CREATE QUEUE NUMBER
      ---------------------------------- */


      const {
        count
      } =
      await supabaseAdmin
      .from("hospital_bookings")
      .select("*",{
        count:"exact",
        head:true,
      })
      .eq("hospital_id",hospital_id)
      .eq("department_id",department_id)
      .eq("booking_date",today);



      const queuePosition =
        (count || 0) + 1;



      const queueNumber =
        `${department.name
          .substring(0,3)
          .toUpperCase()}-${String(
            queuePosition
          ).padStart(3,"0")}`;





      const bookingCode =
        "NHS-" +
        crypto
        .randomBytes(3)
        .toString("hex")
        .toUpperCase();



      const estimatedWait =
        queuePosition * 10;




      /* ----------------------------------
         CREATE ONLINE BOOKING
      ---------------------------------- */


      const {
        data: booking,
        error: bookingError,
      }
      =
      await supabaseAdmin
      .from("hospital_bookings")
      .insert({

        hospital_id,

        department_id,


        // NASARA AUTH USER
        patient_id: patientId,


        booking_date: today,


        queue_number:
          queueNumber,


        queue_position:
          queuePosition,


        booking_code:
          bookingCode,


        qr_code:
          bookingCode,


        estimated_wait_minutes:
          estimatedWait,


        priority:
          "normal",


        priority_level:
          0,


        current_stage:
          "waiting",


        status:
          "waiting",


        condition:
          condition || null,

      })
      .select()
      .single();





      if(bookingError){

        return res.status(400).json({
          success:false,
          error:bookingError.message,
        });

      }




      return res.json({

        success:true,

        message:
        "Queue joined successfully.",

        booking,

      });



    } catch(error){

      console.log(
        "ONLINE QUEUE ERROR:",
        error
      );


      return res.status(500).json({

        success:false,

        error:error.message,

      });

    }

  }
);
/* =========================================================
   REGISTER PATIENT (DEPARTMENT STAFF ONLY)
========================================================= */

router.post(
  "/register-patient",
  authenticate,
  async (req, res) => {

    try {

      const userId = req.user.id;


      /* -----------------------------
         CHECK DEPARTMENT STAFF
      ----------------------------- */

      const {
        data: staff,
        error: staffError,
      } =
      await supabaseAdmin
        .from("hospital_department_staff")
        .select(`
          id,
          hospital_id,
          department_id,
          status,
          active
        `)
        .eq(
          "user_id",
          userId
        )
        .eq(
          "active",
          true
        )
        .eq(
          "status",
          "approved"
        )
        .maybeSingle();



      if(staffError){

        return res.status(500).json({

          success:false,

          error:
          staffError.message,

        });

      }



      if(!staff){

        return res.status(403).json({

          success:false,

          error:
          "You are not approved department staff.",

        });

      }



      /* -----------------------------
         REQUEST BODY
      ----------------------------- */

      const {

        full_name,

        phone,

        ghana_card_number,

        nhis_number,

        gender,

        date_of_birth,

        address,

      } = req.body;



      if(!full_name){

        return res.status(400).json({

          success:false,

          error:
          "Full name is required.",

        });

      }



      const patientPhone =
        phone?.trim() || null;


      const ghanaCard =
        ghana_card_number?.trim() || null;


      const nhis =
        nhis_number?.trim() || null;



      /* -----------------------------
         DUPLICATE PHONE
      ----------------------------- */

      if(patientPhone){

        const {
          data:existingPhone
        } =
        await supabaseAdmin
          .from("patient_records")
          .select("id")
          .eq(
            "phone",
            patientPhone
          )
          .maybeSingle();



        if(existingPhone){

          return res.status(400).json({

            success:false,

            error:
            "Patient with this phone number already exists.",

          });

        }

      }



      /* -----------------------------
         DUPLICATE GHANA CARD
      ----------------------------- */

      if(ghanaCard){

        const {
          data:existingGhana
        } =
        await supabaseAdmin
          .from("patient_records")
          .select("id")
          .eq(
            "ghana_card_number",
            ghanaCard
          )
          .maybeSingle();



        if(existingGhana){

          return res.status(400).json({

            success:false,

            error:
            "Patient with this Ghana Card already exists.",

          });

        }

      }



      /* -----------------------------
         DUPLICATE NHIS
      ----------------------------- */

      if(nhis){

        const {
          data:existingNhis
        } =
        await supabaseAdmin
          .from("patient_records")
          .select("id")
          .eq(
            "nhis_number",
            nhis
          )
          .maybeSingle();



        if(existingNhis){

          return res.status(400).json({

            success:false,

            error:
            "Patient with this NHIS number already exists.",

          });

        }

      }



      /* -----------------------------
         CREATE WALK-IN PATIENT
      ----------------------------- */

      const {
        data:patient,
        error
      } =
      await supabaseAdmin
        .from("patient_records")
        .insert({

          full_name:
            full_name.trim(),

          phone:
            patientPhone,

          ghana_card_number:
            ghanaCard,

          nhis_number:
            nhis,

          gender:
            gender || null,

          date_of_birth:
            date_of_birth || null,

          address:
            address?.trim() || null,


          /*
            STAFF WHO REGISTERED
          */

          registered_by:
            userId,


          registered_by_type:
            "department_staff",

        })
        .select()
        .single();



      if(error){

        return res.status(400).json({

          success:false,

          error:error.message,

        });

      }



      return res.json({

        success:true,

        message:
        "Patient registered successfully.",

        patient,

      });



    }catch(err){

      console.log(err);


      return res.status(500).json({

        success:false,

        error:err.message,

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
   DEPARTMENT STAFF DASHBOARD
   Uses Nasara authenticated user account
========================================================= */

router.get(
  "/staff-department-dashboard",
  authenticate,
  async (req, res) => {

    try {

      const userId = req.user.id;

      /* ----------------------------------
         FIND STAFF PROFILE
      ---------------------------------- */

      const {
        data: staff,
        error: staffError,
      } =
      await supabaseAdmin
        .from("hospital_department_staff")
        .select(`
          id,
          user_id,
          hospital_id,
          department_id,
          full_name,
          role,
          active,
          hospital_departments(
            id,
            name
          ),
          hospitals(
            id,
            name,
            city
          )
        `)
        .eq("user_id", userId)
        .eq("active", true)
        .maybeSingle();

      if (staffError) {

        console.log(
          "Staff lookup error:",
          staffError.message
        );

        return res.status(400).json({

          success: false,

          error: staffError.message,

        });

      }

      if (!staff) {

        return res.status(403).json({

          success: false,

          error:
            "You are not registered as hospital staff.",

        });

      }

      /* ----------------------------------
         TODAY
      ---------------------------------- */

      const today =
        new Date()
          .toISOString()
          .split("T")[0];

      /* ----------------------------------
         LOAD TODAY'S BOOKINGS
      ---------------------------------- */

      const {
        data: patients,
        error: patientsError,
      } =
      await supabaseAdmin
        .from("hospital_bookings")
        .select(`
          *,
          patient_records(*),
          hospital_departments!hospital_bookings_department_id_fkey(
            id,
            name
          )
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

      if (patientsError) {

        return res.status(400).json({

          success: false,

          error:
            patientsError.message,

        });

      }

      const bookings =
        patients || [];

      /* ----------------------------------
         STATISTICS
      ---------------------------------- */

      const waiting =
        bookings.filter(
          p => p.status === "waiting"
        ).length;

      const called =
        bookings.filter(
          p => p.status === "called"
        ).length;

      const checkedIn =
        bookings.filter(
          p => p.status === "checked_in"
        ).length;

      const completed =
        bookings.filter(
          p => p.status === "completed"
        ).length;

      const cancelled =
        bookings.filter(
          p => p.status === "cancelled"
        ).length;

      const emergency =
        bookings.filter(
          p => p.priority === "emergency"
        ).length;

      const urgent =
        bookings.filter(
          p => p.priority === "urgent"
        ).length;

      /* ----------------------------------
         CURRENT PATIENT
      ---------------------------------- */

      const currentPatient =
        bookings.find(
          p =>
            p.status === "called" ||
            p.status === "checked_in"
        ) || null;

      /* ----------------------------------
         NEXT PATIENTS
      ---------------------------------- */

      const nextPatients =
        bookings
          .filter(
            p => p.status === "waiting"
          )
          .slice(0, 5);

      /* ----------------------------------
         RESPONSE
      ---------------------------------- */

      return res.json({

        success: true,

        dashboard: {

          staff_name:
            staff.full_name,

          role:
            staff.role,

          hospital:
            staff.hospitals?.name,

          city:
            staff.hospitals?.city,

          department:
            staff.hospital_departments?.name,

        },

        stats: {

          total_patients:
            bookings.length,

          waiting,

          called,

          checked_in:
            checkedIn,

          completed,

          cancelled,

          emergency,

          urgent,

        },

        current_patient:
          currentPatient,

        next_patients:
          nextPatients,

        patients:
          bookings,

      });

    } catch (err) {

      console.log(
        "Department Dashboard Error:",
        err
      );

      return res.status(500).json({

        success: false,

        error:
          err.message,

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
  departmentStaffAuth,
  async (req, res) => {

    try {

      const {
        hospital_id,
        department_id
      } =
      req.departmentStaff;

 const { data, error } =
await supabaseAdmin
.from("hospital_voice_queue")
.select(`
  id,
  booking_id,
  queue_number,
  message,
  voices,
  priority,
  department_id,
  created_at,
  hospital_departments (
    id,
    name
  )
`)
.eq(
  "hospital_id",
  hospital_id
)
.eq(
  "department_id",
  department_id
)
.eq(
  "played",
  false
)
.order(
  "priority",
  {
    ascending:true
  }
)
.order(
  "created_at",
  {
    ascending:true
  }
)
.limit(1);

      if(error){

        return res.status(400).json({

          success:false,

          error:error.message,

        });

      }


     return res.json({

  success:true,

  announcement:
    data?.[0] || null,

});
    }catch(err){

      return res.status(500).json({

        success:false,

        error:err.message,

      });

    }

  }
);
/* =========================================================
   GET DEPARTMENT VOICE SETTINGS
   Gets available announcement languages
   and templates for a department
========================================================= */

router.get(
  "/department-voice-settings",
  authenticate,
  departmentStaffAuth,
  async (req, res) => {

    try {

      const {
        hospital_id,
        department_id
      } = req.departmentStaff;


      const {
        data: languages,
        error: languageError
      } =
      await supabaseAdmin
        .from(
          "hospital_announcement_languages"
        )
        .select(`
          id,
          language_code,
          language_name,
          enabled,
          display_order
        `)
        .eq(
          "hospital_id",
          hospital_id
        )
        .eq(
          "enabled",
          true
        )
        .order(
          "display_order",
          {
            ascending:true,
          }
        );


      if(languageError){

        return res.status(400).json({

          success:false,

          error:
          languageError.message

        });

      }



      const {
        data: templates,
        error: templateError
      } =
      await supabaseAdmin
        .from(
          "hospital_announcement_templates"
        )
        .select(`
          id,
          language_code,
          template_name,
          template_text,
          enabled
        `)
        .eq(
          "hospital_id",
          hospital_id
        )
        .eq(
          "enabled",
          true
        )
        .order(
          "template_name",
          {
            ascending:true,
          }
        );


      if(templateError){

        return res.status(400).json({

          success:false,

          error:
          templateError.message

        });

      }



      return res.json({

        success:true,

        hospital_id,

        department_id,

        languages:
          languages || [],

        templates:
          templates || []

      });



    }catch(err){

      console.log(
        "Voice settings error:",
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


/* =========================================================
   MARK COMPLETE VOICE SEQUENCE PLAYED
========================================================= */

router.post(
  "/voice-queue/played",
  authenticate,
  departmentStaffAuth,
  async(req,res)=>{

    try{

      const {
        hospital_id,
        department_id
      } = req.departmentStaff;


      const {
        booking_id
      } = req.body;


      if(!booking_id){

        return res.status(400).json({

          success:false,

          error:"booking_id required"

        });

      }



      const {
        data,
        error
      } =
      await supabaseAdmin
      .from("hospital_voice_queue")
      .update({

        played:true,

        played_at:
          new Date().toISOString()

      })
      .eq(
        "booking_id",
        booking_id
      )
      .eq(
        "hospital_id",
        hospital_id
      )
      .eq(
        "department_id",
        department_id
      )
      .select();



      if(error){

        return res.status(400).json({

          success:false,

          error:error.message

        });

      }



      return res.json({

        success:true,

        announcements:data

      });


    }
    catch(err){

      return res.status(500).json({

        success:false,

        error:err.message

      });

    }

  }
);
/* =========================================================
   UPLOAD VOICE TEMPLATE
========================================================= */

router.post(
  "/upload-voice-recording",
  authenticate,
  departmentStaffAuth,
  async (req, res) => {

    try {

      const {
        hospital_id,
        department_id,
      } = req.departmentStaff;

      const {
        language,
        audio_url,
      } = req.body;

      if (
        !language ||
        !audio_url
      ) {

        return res.status(400).json({

          success: false,

          error:
            "language and audio_url are required",

        });

      }

      /*
      ========================================
      CHECK IF TEMPLATE EXISTS
      ========================================
      */

      const {
        data: existing,
      } =
      await supabaseAdmin
      .from("hospital_voice_templates")
      .select("id")
      .eq("hospital_id", hospital_id)
      .eq("department_id", department_id)
      .eq("language", language)
      .maybeSingle();

      let data;
      let error;

      /*
      ========================================
      UPDATE EXISTING TEMPLATE
      ========================================
      */

      if (existing) {

        ({
          data,
          error,
        } =
        await supabaseAdmin
        .from("hospital_voice_templates")
        .update({

          audio_url,

          created_by:
            req.user.id,

          active: true,

        })
        .eq("id", existing.id)
        .select()
        .single());

      }

      /*
      ========================================
      CREATE NEW TEMPLATE
      ========================================
      */

      else {

        ({
          data,
          error,
        } =
        await supabaseAdmin
        .from("hospital_voice_templates")
        .insert({

          hospital_id,

          department_id,

          language,

          audio_url,

          active: true,

          created_by:
            req.user.id,

        })
        .select()
        .single());

      }

      if (error) {

  return res.status(400).json({

    success: false,

    error: error.message,

  });

}

/*
========================================
AUTO-ENABLE THIS LANGUAGE FOR DEPARTMENT
========================================
*/

await supabaseAdmin
  .from("hospital_department_languages")
  .upsert(
    {
      hospital_id,
      department_id,
      language,
      enabled: true,
    },
    {
      onConflict:
        "hospital_id,department_id,language",
    }
  );

return res.json({

  success: true,

  template: data,

});
    } catch (err) {

      console.log(
        "Voice template upload error:",
        err
      );

      return res.status(500).json({

        success: false,

        error: err.message,

      });

    }

  }
);

/* =========================================================
   GET VOICE TEMPLATE
========================================================= */

router.get(
  "/voice-template",
  authenticate,
  departmentStaffAuth,
  async (req, res) => {

    try {

      const {
        hospital_id,
        department_id,
      } = req.departmentStaff;


      const {
        language = "en",
        template_type = "queue_call",
      } = req.query;



      const {
        data,
        error,
      } =
      await supabaseAdmin
      .from("hospital_voice_templates")
      .select(`
        id,
        hospital_id,
        department_id,
        language,
        template_type,
        audio_url,
        active,
        updated_at
      `)
      .eq(
        "hospital_id",
        hospital_id
      )
      .eq(
        "department_id",
        department_id
      )
      .eq(
        "language",
        language
      )
      .eq(
        "template_type",
        template_type
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



      return res.json({

        success: true,

        template: data || null,

      });



    } catch (err) {


      console.log(
        "Get voice template error:",
        err
      );


      return res.status(500).json({

        success: false,

        error: err.message,

      });


    }

  }
);

/* =========================================================
   UPLOAD VOICE TEMPLATE
========================================================= */

router.post(
  "/upload-voice-template",
  authenticate,
  departmentStaffAuth,
  async (req, res) => {

    try {

      const {
        hospital_id,
        department_id,
      } = req.departmentStaff;


      const {
        language,
        template_type,
        audio_url,
      } = req.body;



      if (
        !language ||
        !template_type ||
        !audio_url
      ) {

        return res.status(400).json({

          success:false,

          error:"Missing template information"

        });

      }



      const {
        data,
        error
      } =
      await supabaseAdmin
      .from(
        "hospital_voice_templates"
      )
      .insert({

        hospital_id,

        department_id,

        language,

        template_type,

        audio_url,

        active:true

      })
      .select()
      .single();



      if(error){

        throw error;

      }



      return res.json({

        success:true,

        template:data

      });



    }
    catch(error){


      console.log(
        "Upload voice template error:",
        error
      );


      return res.status(500).json({

        success:false,

        error:error.message

      });


    }

  }
);
/* =========================================================
   MY VOICE TEMPLATES
========================================================= */
router.get(
"/voice-templates",
authenticate,
departmentStaffAuth,
async(req,res)=>{

try{

const {
hospital_id,
department_id
}
=
req.departmentStaff;


const {
data,
error
}
=
await supabaseAdmin
.from("hospital_voice_templates")
.select(`
id,
language,
template_type,
audio_url,
active,
updated_at
`)
.eq(
"hospital_id",
hospital_id
)
.eq(
"department_id",
department_id
)
.order(
"created_at",
{
ascending:false
}
);


if(error){

return res.status(400).json({
success:false,
error:error.message
});

}


return res.json({

success:true,

templates:data || []

});


}
catch(error){

return res.status(500).json({

success:false,

error:error.message

});

}

});

/* =========================================================
   GET VOICE RECORDINGS
   Hospital staff list available announcement voices
========================================================= */

router.get(
  "/voice-recordings",
  authenticate,
  departmentStaffAuth,
  async (req, res) => {

    try {

      const {
        hospital_id,
        department_id
      } = req.departmentStaff;


      const {
        data,
        error
      } =
      await supabaseAdmin
      .from(
        "hospital_voice_recordings"
      )
      .select(`
        id,
        language_code,
        voice_name,
        audio_url,
        enabled,
        created_at
      `)
      .eq(
        "hospital_id",
        hospital_id
      )
      .eq(
        "department_id",
        department_id
      )
      .eq(
        "enabled",
        true
      )
      .order(
        "created_at",
        {
          ascending:false
        }
      );


      if(error){

        return res.status(400).json({

          success:false,

          error:error.message

        });

      }


      return res.json({

        success:true,

        recordings:
          data || []

      });



    }catch(err){

      console.log(
        "Voice recordings error:",
        err
      );


      return res.status(500).json({

        success:false,

        error:err.message

      });

    }

  }
);
/* =========================================================
   UPLOAD VOICE RECORDING
   Department staff records local language announcement
========================================================= */

router.post(
  "/upload-voice-recording",
  authenticate,
  departmentStaffAuth,
  async (req, res) => {

    try {

      const {
        hospital_id,
        department_id
      } = req.departmentStaff;


      const {
        booking_id,
        queue_number,
        language,
        audio_url,
        message
      } = req.body;


      if (
        !booking_id ||
        !queue_number ||
        !audio_url ||
        !language
      ) {

        return res.status(400).json({

          success:false,

          error:
          "booking_id, queue_number, language and audio_url are required"

        });

      }


      /*
        Save voice announcement
      */

      const {
        data,
        error
      } =
      await supabaseAdmin
      .from(
        "hospital_voice_queue"
      )
      .insert({

        hospital_id,

        department_id,

        booking_id,

        queue_number,

        message:
          message ||
          `Queue ${queue_number}, please proceed.`,

        language,

        audio_url,

        audio_type:
        "recording",

        played:false,

      })
      .select()
      .single();



      if(error){

        return res.status(400).json({

          success:false,

          error:error.message

        });

      }



      return res.json({

        success:true,

        announcement:data

      });



    }catch(err){

      console.log(
        "Upload voice error:",
        err
      );


      return res.status(500).json({

        success:false,

        error:err.message

      });

    }

  }
);
/* =========================================================
   GET DEPARTMENT VOICE SETTINGS
   Returns enabled announcement languages
   and templates for department staff
========================================================= */

router.get(
  "/department-voice-settings",
  authenticate,
  departmentStaffAuth,
  async (req, res) => {

    try {

      const {
        hospital_id,
        department_id
      } = req.departmentStaff;


      /*
        Load enabled languages
      */

      const {
        data: languages,
        error: languageError
      } =
      await supabaseAdmin
      .from(
        "hospital_announcement_languages"
      )
      .select(`
        id,
        language_code,
        language_name,
        display_order
      `)
      .eq(
        "hospital_id",
        hospital_id
      )
      .eq(
        "enabled",
        true
      )
      .order(
        "display_order",
        {
          ascending:true
        }
      );


      if(languageError){

        return res.status(400).json({

          success:false,

          error:
          languageError.message

        });

      }



      /*
        Load announcement templates
      */

      const {
        data: templates,
        error: templateError
      }
      =
      await supabaseAdmin
      .from(
        "hospital_announcement_templates"
      )
      .select(`
        id,
        language_code,
        template_name,
        template_text
      `)
      .eq(
        "hospital_id",
        hospital_id
      )
      .eq(
        "enabled",
        true
      );



      if(templateError){

        return res.status(400).json({

          success:false,

          error:
          templateError.message

        });

      }



      return res.json({

        success:true,

        department_id,

        languages:
          languages || [],

        templates:
          templates || [],

        default_language:
          "en"

      });



    }catch(err){

      console.log(
        "Voice settings error:",
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
/* =========================================================
   CREATE DEFAULT VOICE LANGUAGES
   Add default Ghana announcement languages
========================================================= */

router.post(
  "/create-default-voice-languages",
  authenticate,
  async (req, res) => {

    try {

      const {
        hospital_id
      } = req.body;


      if(!hospital_id){

        return res.status(400).json({

          success:false,

          error:
          "hospital_id is required"

        });

      }



      const defaultLanguages = [

        {
          hospital_id,
          language_code:"en",
          language_name:"English",
          display_order:1,
          enabled:true,
        },

        {
          hospital_id,
          language_code:"tw",
          language_name:"Twi",
          display_order:2,
          enabled:true,
        },

        {
          hospital_id,
          language_code:"ga",
          language_name:"Ga",
          display_order:3,
          enabled:true,
        },

        {
          hospital_id,
          language_code:"ee",
          language_name:"Ewe",
          display_order:4,
          enabled:true,
        },

        {
          hospital_id,
          language_code:"dag",
          language_name:"Dagbani",
          display_order:5,
          enabled:true,
        },

        {
          hospital_id,
          language_code:"ha",
          language_name:"Hausa",
          display_order:6,
          enabled:true,
        },

      ];



      const {
        data,
        error
      }
      =
      await supabaseAdmin
      .from(
        "hospital_announcement_languages"
      )
      .upsert(
        defaultLanguages,
        {
          onConflict:
          "hospital_id,language_code"
        }
      )
      .select();



      if(error){

        return res.status(400).json({

          success:false,

          error:error.message

        });

      }



      return res.json({

        success:true,

        message:
        "Default voice languages created",

        languages:
        data

      });



    }catch(err){

      console.log(
        "Create voice languages error:",
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
/* =========================================================
   DELETE VOICE RECORDING
   Remove hospital voice file record
========================================================= */

router.delete(
  "/voice-recordings/:id",
  authenticate,
  departmentStaffAuth,
  async (req, res) => {

    try {

      const {
        hospital_id,
        department_id
      } = req.departmentStaff;


      const {
        id
      } = req.params;


      if(!id){

        return res.status(400).json({

          success:false,

          error:
          "Voice recording id required"

        });

      }


      const {
        data: recording,
        error: findError
      }
      =
      await supabaseAdmin
      .from(
        "hospital_voice_recordings"
      )
      .select("*")
      .eq(
        "id",
        id
      )
      .eq(
        "hospital_id",
        hospital_id
      )
      .eq(
        "department_id",
        department_id
      )
      .maybeSingle();



      if(findError){

        return res.status(400).json({

          success:false,

          error:
          findError.message

        });

      }



      if(!recording){

        return res.status(404).json({

          success:false,

          error:
          "Voice recording not found"

        });

      }



      const {
        error: deleteError
      }
      =
      await supabaseAdmin
      .from(
        "hospital_voice_recordings"
      )
      .delete()
      .eq(
        "id",
        id
      )
      .eq(
        "hospital_id",
        hospital_id
      )
      .eq(
        "department_id",
        department_id
      );



      if(deleteError){

        return res.status(400).json({

          success:false,

          error:
          deleteError.message

        });

      }



      return res.json({

        success:true,

        message:
        "Voice recording deleted"

      });



    }catch(err){

      console.log(
        "Delete voice error:",
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
/* =========================================================
   DELETE VOICE TEMPLATE
========================================================= */

router.delete(
  "/delete-voice-template/:id",
  authenticate,
  departmentStaffAuth,
  async (req, res) => {

    try {

      const {
        hospital_id,
        department_id
      } = req.departmentStaff;


      const {
        id
      } = req.params;


      const {
        data: template,
        error: findError
      } =
      await supabaseAdmin
      .from("hospital_voice_templates")
      .select("id")
      .eq("id", id)
      .eq("hospital_id", hospital_id)
      .eq("department_id", department_id)
      .maybeSingle();


      if(findError){

        return res.status(400).json({
          success:false,
          error:findError.message
        });

      }


      if(!template){

        return res.status(404).json({
          success:false,
          error:"Voice template not found"
        });

      }



      const {
        error
      } =
      await supabaseAdmin
      .from("hospital_voice_templates")
      .delete()
      .eq("id", id)
      .eq("hospital_id", hospital_id)
      .eq("department_id", department_id);



      if(error){

        return res.status(400).json({
          success:false,
          error:error.message
        });

      }



      return res.json({

        success:true,

        message:
        "Voice template deleted"

      });


    }
    catch(err){

      console.log(
        "DELETE VOICE TEMPLATE ERROR:",
        err
      );


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


module.exports = router;