const express = require("express");

const router = express.Router();

const { createClient } =
  require("@supabase/supabase-js");

/* ================= SUPABASE ADMIN ================= */

const supabaseAdmin =
  createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

/* =========================================================
   GET NEAREST RESTAURANTS

   Customer current GPS
          ↓
   Restaurant saved GPS
          ↓
   SAME Haversine calculation as Emergency Hospitals
          ↓
   distance_km
          ↓
   Nearest restaurant first
========================================================= */

router.get(
  "/nearby-restaurants",
  async (req, res) => {
    try {
      const latitude =
        Number(req.query.latitude);

      const longitude =
        Number(req.query.longitude);

      /* ================= VALIDATE CUSTOMER GPS ================= */

      if (
        !Number.isFinite(latitude) ||
        !Number.isFinite(longitude) ||
        latitude < -90 ||
        latitude > 90 ||
        longitude < -180 ||
        longitude > 180
      ) {
        return res.status(400).json({
          success: false,
          error:
            "Valid customer current location is required.",
        });
      }

      /* ================= GET ACTIVE RESTAURANTS ================= */

      const {
        data,
        error,
      } =
        await supabaseAdmin
          .from("restaurants")
          .select(`
            id,
            owner_id,
            name,
            description,
            phone,
            whatsapp_phone,
            address,
            latitude,
            longitude,
            logo_url,
            cover_image_url,
            opening_time,
            closing_time,
            is_open,
            status,
            momo_provider,
            momo_number,
            momo_account_name,
            accepts_momo,
            accepts_cash,
            accepts_card
          `)
          .eq(
            "status",
            "active"
          );

      if (error) {
        console.error(
          "RESTAURANT DATABASE ERROR:",
          error
        );

        return res.status(400).json({
          success: false,
          error:
            error.message,
        });
      }

      /* ================= DEGREES → RADIANS ================= */

      const toRadians = (
        value
      ) =>
        value *
        (Math.PI / 180);

      /* ================= CALCULATE DISTANCE ================= */

      const restaurants =
        (data || []).map(
          (restaurant) => {

            const restaurantLat =
              Number(
                restaurant.latitude
              );

            const restaurantLng =
              Number(
                restaurant.longitude
              );

            /*
             * Restaurant does not have
             * valid GPS coordinates.
             *
             * Put it at the bottom.
             */

            if (
              !Number.isFinite(
                restaurantLat
              ) ||
              !Number.isFinite(
                restaurantLng
              )
            ) {
              return {
                ...restaurant,
                distance_km:
                  null,
              };
            }

            /*
             * SAME EARTH RADIUS
             * AS EMERGENCY HOSPITALS
             */

            const R = 6371;

            const dLat =
              toRadians(
                restaurantLat -
                  latitude
              );

            const dLng =
              toRadians(
                restaurantLng -
                  longitude
              );

            const a =
              Math.sin(
                dLat / 2
              ) *
                Math.sin(
                  dLat / 2
                ) +
              Math.cos(
                toRadians(
                  latitude
                )
              ) *
                Math.cos(
                  toRadians(
                    restaurantLat
                  )
                ) *
                Math.sin(
                  dLng / 2
                ) *
                Math.sin(
                  dLng / 2
                );

            const c =
              2 *
              Math.atan2(
                Math.sqrt(a),
                Math.sqrt(
                  1 - a
                )
              );

            const distanceKm =
              Number(
                (
                  R * c
                ).toFixed(2)
              );

            return {
              ...restaurant,
              distance_km:
                distanceKm,
            };
          }
        );

      /* ================= SORT NEAREST FIRST ================= */

      restaurants.sort(
        (a, b) => {

          if (
            a.distance_km ===
            null
          ) {
            return 1;
          }

          if (
            b.distance_km ===
            null
          ) {
            return -1;
          }

          return (
            a.distance_km -
            b.distance_km
          );
        }
      );

      /* ================= RESPONSE ================= */

      return res.json({
        success: true,

        customer_location: {
          latitude,
          longitude,
        },

        restaurants,
      });

    } catch (err) {

      console.error(
        "NEARBY RESTAURANTS ERROR:",
        err
      );

      return res.status(500).json({
        success: false,
        error:
          err?.message ||
          "Unable to find nearby restaurants.",
      });
    }
  }
);

module.exports =
  router;