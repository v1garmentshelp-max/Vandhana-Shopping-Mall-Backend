const express = require('express')
const pool = require('../db')
const {
  creditSignupBonus
} = require('../services/rewardPointsService')

const router = express.Router()

router.post(
  '/signup',
  async (req, res) => {
    const {
      name,
      email,
      mobile,
      password
    } = req.body

    if (
      !name ||
      !email ||
      !mobile ||
      !password
    ) {
      return res
        .status(400)
        .json({
          message:
            'All fields are required'
        })
    }

    const client =
      await pool.connect()

    try {
      await client.query(
        'BEGIN'
      )

      const exists =
        await client.query(
          `SELECT id
           FROM vandana_users
           WHERE lower(email) = lower($1)
           LIMIT 1`,
          [email]
        )

      if (
        exists.rows.length >
        0
      ) {
        await client.query(
          'ROLLBACK'
        )

        return res
          .status(409)
          .json({
            message:
              'Email already exists'
          })
      }

      const result =
        await client.query(
          `INSERT INTO vandana_users
           (
             name,
             email,
             mobile,
             password,
             type,
             created_at,
             updated_at
           )
           VALUES
           (
             $1,
             $2,
             $3,
             $4,
             $5,
             NOW(),
             NOW()
           )
           RETURNING
             id,
             name,
             email,
             mobile,
             type`,
          [
            name,
            email,
            mobile,
            password,
            'B2C'
          ]
        )

      const user =
        result.rows[0]

      await creditSignupBonus(
        user.id,
        client
      )

      await client.query(
        'COMMIT'
      )

      return res
        .status(201)
        .json({
          message:
            'B2C customer added',
          user
        })
    } catch (err) {
      try {
        await client.query(
          'ROLLBACK'
        )
      } catch {}

      return res
        .status(500)
        .json({
          message:
            'Server error',
          error:
            err.message
        })
    } finally {
      client.release()
    }
  }
)

router.get(
  '/',
  async (req, res) => {
    try {
      const result =
        await pool.query(
          `SELECT
             id,
             name,
             email,
             mobile
           FROM vandana_users
           WHERE type = $1
           ORDER BY id DESC`,
          ['B2C']
        )

      return res.json(
        result.rows
      )
    } catch (err) {
      return res
        .status(500)
        .json({
          message:
            'Error fetching B2C customers',
          error:
            err.message
        })
    }
  }
)

module.exports = router