const express = require('express')
const pool = require('../db')
const bcrypt = require('bcryptjs')
const nodemailer = require('nodemailer')
const jwt = require('jsonwebtoken')
const crypto = require('crypto')
const {
  creditSignupBonus
} = require('../services/rewardPointsService')

const router = express.Router()

const JWT_SECRET =
  process.env.JWT_SECRET ||
  'change-me-in-env'

const DB_SCHEMA =
  process.env.DB_SCHEMA ||
  'public'

const USERS_TABLE =
  `"${DB_SCHEMA}"."vandana_users"`

const OTP_EXPIRY_MS = 10 * 60 * 1000
const OTP_RESEND_SECONDS = 60
const OTP_MAX_ATTEMPTS = 5

const getPasswordResetSecret = () => {
  const secret = String(process.env.PASSWORD_RESET_SECRET || '').trim()

  if (!secret) {
    throw new Error('PASSWORD_RESET_SECRET is not configured')
  }

  return secret
}

const getOtpReference = value =>
  crypto
    .createHash('sha256')
    .update(String(value || ''))
    .digest('hex')

const transporter =
  nodemailer.createTransport({
    host:
      process.env.SMTP_HOST ||
      'smtp.gmail.com',
    port: Number(
      process.env.SMTP_PORT ||
        465
    ),
    secure: true,
    auth: {
      user:
        process.env.SMTP_USER,
      pass:
        process.env.SMTP_PASS
    }
  })

function signToken(user) {
  return jwt.sign(
    {
      id: user.id,
      email: user.email,
      type:
        user.type ||
        'B2C'
    },
    JWT_SECRET,
    {
      expiresIn: '7d'
    }
  )
}

function requireAuth(
  req,
  res,
  next
) {
  const authHeader =
    req.headers.authorization ||
    ''

  const token =
    authHeader.startsWith(
      'Bearer '
    )
      ? authHeader.slice(7)
      : ''

  if (!token) {
    return res
      .status(401)
      .json({
        message: 'Unauthorized'
      })
  }

  try {
    const decoded =
      jwt.verify(
        token,
        JWT_SECRET
      )

    req.user = decoded

    return next()
  } catch (err) {
    return res
      .status(401)
      .json({
        message: 'Unauthorized',
        error: err.message
      })
  }
}

function isBcryptHash(
  value = ''
) {
  return (
    typeof value ===
      'string' &&
    (
      value.startsWith(
        '$2a$'
      ) ||
      value.startsWith(
        '$2b$'
      ) ||
      value.startsWith(
        '$2y$'
      )
    )
  )
}

function isValidEmail(
  email = ''
) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(
    String(
      email
    ).trim()
  )
}

function isValidMobile(
  mobile = ''
) {
  return /^[6-9]\d{9}$/.test(
    String(
      mobile
    ).trim()
  )
}

async function createUser(
  req,
  res
) {
  const {
    name,
    email,
    mobile,
    password,
    type
  } = req.body || {}

  const cleanName =
    String(
      name || ''
    ).trim()

  const cleanEmail =
    String(
      email || ''
    )
      .trim()
      .toLowerCase()

  const cleanMobile =
    String(
      mobile || ''
    ).trim()

  const cleanPassword =
    String(
      password || ''
    )

  const cleanType =
    String(
      type || 'B2C'
    ).trim() || 'B2C'

  if (
    !cleanName ||
    !cleanEmail ||
    !cleanMobile ||
    !cleanPassword
  ) {
    return res
      .status(400)
      .json({
        message:
          'name, email, mobile and password are required'
      })
  }

  if (
    !isValidEmail(
      cleanEmail
    )
  ) {
    return res
      .status(400)
      .json({
        message:
          'Invalid email address'
      })
  }

  if (
    !isValidMobile(
      cleanMobile
    )
  ) {
    return res
      .status(400)
      .json({
        message:
          'Invalid mobile number'
      })
  }

  if (
    cleanPassword.length <
    6
  ) {
    return res
      .status(400)
      .json({
        message:
          'Password must be at least 6 characters'
      })
  }

  const client =
    await pool.connect()

  try {
    await client.query(
      'BEGIN'
    )

    const existing =
      await client.query(
        `SELECT id
         FROM ${USERS_TABLE}
         WHERE lower(email) = $1
         LIMIT 1`,
        [cleanEmail]
      )

    if (
      existing.rows.length >
      0
    ) {
      await client.query(
        'ROLLBACK'
      )

      return res
        .status(409)
        .json({
          message:
            'User already exists with this email'
        })
    }

    const hashedPassword =
      await bcrypt.hash(
        cleanPassword,
        10
      )

    const insert =
      await client.query(
        `INSERT INTO ${USERS_TABLE}
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
          cleanName,
          cleanEmail,
          cleanMobile,
          hashedPassword,
          cleanType
        ]
      )

    const user =
      insert.rows[0]

    if (
      String(
        user.type ||
          'B2C'
      ).toUpperCase() ===
      'B2C'
    ) {
      await creditSignupBonus(
        user.id,
        client
      )
    }

    await client.query(
      'COMMIT'
    )

    return res
      .status(201)
      .json({
        message:
          'Account created successfully',
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
          err.message,
        detail:
          err.detail || null,
        code:
          err.code || null,
        table:
          err.table || null,
        constraint:
          err.constraint ||
          null
      })
  } finally {
    client.release()
  }
}

router.post(
  '/signup',
  createUser
)

router.post(
  '/register',
  createUser
)

router.post(
  '/login',
  async (req, res) => {
    const {
      email,
      password
    } = req.body || {}

    const cleanEmail =
      String(
        email || ''
      )
        .trim()
        .toLowerCase()

    const cleanPassword =
      String(
        password || ''
      )

    if (
      !cleanEmail ||
      !cleanPassword
    ) {
      return res
        .status(400)
        .json({
          message:
            'Email and password are required'
        })
    }

    try {
      const result =
        await pool.query(
          `SELECT *
           FROM ${USERS_TABLE}
           WHERE lower(email) = $1
           LIMIT 1`,
          [cleanEmail]
        )

      if (
        result.rows.length ===
        0
      ) {
        return res
          .status(401)
          .json({
            message:
              'Invalid credentials'
          })
      }

      const user =
        result.rows[0]

      let isMatch = false

      if (user.password) {
        if (
          isBcryptHash(
            user.password
          )
        ) {
          isMatch =
            await bcrypt.compare(
              cleanPassword,
              user.password
            )
        } else {
          isMatch =
            cleanPassword ===
            user.password
        }
      }

      if (!isMatch) {
        return res
          .status(401)
          .json({
            message:
              'Invalid credentials'
          })
      }

      const token =
        signToken(user)

      return res.json({
        token,
        user: {
          id: user.id,
          name:
            user.name,
          email:
            user.email,
          mobile:
            user.mobile,
          type:
            user.type ||
            'B2C'
        }
      })
    } catch (err) {
      return res
        .status(500)
        .json({
          message:
            'Server error',
          error:
            err.message,
          detail:
            err.detail ||
            null,
          code:
            err.code ||
            null,
          table:
            err.table ||
            null,
          constraint:
            err.constraint ||
            null
        })
    }
  }
)

router.get(
  '/me',
  requireAuth,
  async (req, res) => {
    try {
      const result =
        await pool.query(
          `SELECT
             id,
             name,
             email,
             mobile,
             type,
             created_at,
             updated_at
           FROM ${USERS_TABLE}
           WHERE id = $1
           LIMIT 1`,
          [req.user.id]
        )

      if (
        result.rows.length ===
        0
      ) {
        return res
          .status(404)
          .json({
            message:
              'User not found'
          })
      }

      return res.json(
        result.rows[0]
      )
    } catch (err) {
      return res
        .status(500)
        .json({
          message:
            'Server error',
          error:
            err.message,
          detail:
            err.detail ||
            null,
          code:
            err.code ||
            null
        })
    }
  }
)

router.post(
  '/change-password',
  requireAuth,
  async (req, res) => {
    const {
      old_password,
      new_password
    } = req.body || {}

    const oldPassword =
      String(
        old_password ||
          ''
      )

    const newPassword =
      String(
        new_password ||
          ''
      )

    if (
      !oldPassword ||
      !newPassword
    ) {
      return res
        .status(400)
        .json({
          message:
            'Both passwords required'
        })
    }

    if (
      newPassword.length <
      6
    ) {
      return res
        .status(400)
        .json({
          message:
            'New password must be at least 6 characters'
        })
    }

    try {
      const result =
        await pool.query(
          `SELECT password
           FROM ${USERS_TABLE}
           WHERE id = $1
           LIMIT 1`,
          [req.user.id]
        )

      if (
        result.rows.length ===
        0
      ) {
        return res
          .status(404)
          .json({
            message:
              'User not found'
          })
      }

      const currentPassword =
        result.rows[0]
          .password

      let isMatch = false

      if (
        isBcryptHash(
          currentPassword
        )
      ) {
        isMatch =
          await bcrypt.compare(
            oldPassword,
            currentPassword
          )
      } else {
        isMatch =
          oldPassword ===
          currentPassword
      }

      if (!isMatch) {
        return res
          .status(401)
          .json({
            message:
              'Invalid credentials'
          })
      }

      const hashed =
        await bcrypt.hash(
          newPassword,
          10
        )

      await pool.query(
        `UPDATE ${USERS_TABLE}
         SET
           password = $1,
           updated_at = NOW()
         WHERE id = $2`,
        [
          hashed,
          req.user.id
        ]
      )

      return res.json({
        message:
          'Password updated'
      })
    } catch (err) {
      return res
        .status(500)
        .json({
          message:
            'Server error',
          error:
            err.message,
          detail:
            err.detail ||
            null,
          code:
            err.code ||
            null
        })
    }
  }
)

router.post(
  '/forgot/start',
  async (req, res) => {
    const {
      email
    } = req.body || {}

    const cleanEmail =
      String(
        email || ''
      )
        .trim()
        .toLowerCase()

    if (!cleanEmail) {
      return res
        .status(400)
        .json({
          message:
            'Email is required'
        })
    }

    try {
      const result =
        await pool.query(
          `SELECT
             id,
             name,
             type,
             otp_last_sent_at
           FROM ${USERS_TABLE}
           WHERE lower(email) = $1
           LIMIT 1`,
          [cleanEmail]
        )

      if (
        result.rows.length ===
        0
      ) {
        return res
          .json({
            message:
              'If an account exists for this email, an OTP has been sent'
          })
      }

      const user = result.rows[0]
      const lastSentAt = user.otp_last_sent_at
        ? new Date(user.otp_last_sent_at).getTime()
        : 0
      const elapsedSeconds = Math.floor((Date.now() - lastSentAt) / 1000)

      if (lastSentAt && elapsedSeconds < OTP_RESEND_SECONDS) {
        return res
          .status(429)
          .json({
            message: `Please wait ${OTP_RESEND_SECONDS - elapsedSeconds} seconds before requesting another OTP`,
            retry_after: OTP_RESEND_SECONDS - elapsedSeconds
          })
      }

      const otp =
        crypto.randomInt(
          100000,
          1000000
        ).toString()

      const otpHash =
        await bcrypt.hash(
          otp,
          10
        )

      const expiresAt =
        new Date(
          Date.now() +
            OTP_EXPIRY_MS
        )

      const client = await pool.connect()

      try {
        await client.query('BEGIN')

        await client.query(
          `UPDATE ${USERS_TABLE}
           SET
             otp = $1,
             otp_expiry = $2,
             otp_attempts = 0,
             otp_last_sent_at = NOW(),
             updated_at = NOW()
           WHERE id = $3`,
          [
            otpHash,
            expiresAt,
            user.id
          ]
        )

        await transporter.sendMail({
          from:
            process.env.FROM_EMAIL ||
            process.env.SMTP_USER,
          to: cleanEmail,
          subject:
            'V1 Garments password reset OTP',
          text:
            `Your V1 Garments password reset OTP is ${otp}. It is valid for 10 minutes.`,
          html:
            `<div style="font-family:Arial,sans-serif;color:#111;max-width:520px;margin:auto;padding:24px"><h2 style="margin:0 0 16px">Reset your V1 Garments password</h2><p>Use the OTP below to continue:</p><div style="font-size:32px;font-weight:700;letter-spacing:8px;margin:24px 0">${otp}</div><p>This OTP is valid for 10 minutes. Do not share it with anyone.</p></div>`
        })

        await client.query('COMMIT')
      } catch (err) {
        await client.query('ROLLBACK')
        throw err
      } finally {
        client.release()
      }

      return res.json({
        message:
          'If an account exists for this email, an OTP has been sent',
        expires_in: Math.floor(OTP_EXPIRY_MS / 1000),
        resend_after: OTP_RESEND_SECONDS
      })
    } catch (err) {
      return res
        .status(500)
        .json({
          message:
            'Could not start reset',
          error:
            err.message,
          detail:
            err.detail ||
            null,
          code:
            err.code ||
            null
        })
    }
  }
)

router.post(
  '/forgot/verify',
  async (req, res) => {
    const {
      email,
      otp
    } = req.body || {}

    const cleanEmail =
      String(
        email || ''
      )
        .trim()
        .toLowerCase()

    const cleanOtp =
      String(
        otp || ''
      ).trim()

    if (
      !cleanEmail ||
      !cleanOtp
    ) {
      return res
        .status(400)
        .json({
          message:
            'Email and OTP are required'
        })
    }

    const client = await pool.connect()

    try {
      await client.query('BEGIN')

      const result =
        await client.query(
          `SELECT
             id,
             email,
             otp,
             otp_expiry,
             otp_attempts
           FROM ${USERS_TABLE}
           WHERE lower(email) = $1
           LIMIT 1
           FOR UPDATE`,
          [cleanEmail]
        )

      if (
        result.rows.length ===
        0
      ) {
        await client.query('ROLLBACK')

        return res
          .status(400)
          .json({
            message:
              'Invalid or expired OTP'
          })
      }

      const user =
        result.rows[0]

      if (
        !user.otp_expiry ||
        new Date(
          user.otp_expiry
        ).getTime() <
          Date.now()
      ) {
        await client.query(
          `UPDATE ${USERS_TABLE}
           SET
             otp = NULL,
             otp_expiry = NULL,
             otp_attempts = 0,
             otp_last_sent_at = NULL,
             updated_at = NOW()
           WHERE id = $1`,
          [user.id]
        )

        await client.query('COMMIT')

        return res
          .status(400)
          .json({
            message:
              'OTP expired'
          })
      }

      if (
        Number(user.otp_attempts || 0) >=
        OTP_MAX_ATTEMPTS
      ) {
        await client.query('ROLLBACK')

        return res
          .status(400)
          .json({
            message:
              'Too many incorrect attempts. Request a new OTP'
          })
      }

      const isMatch =
        await bcrypt.compare(
          cleanOtp,
          String(user.otp || '')
        )

      if (!isMatch) {
        const attempts =
          Number(user.otp_attempts || 0) + 1

        await client.query(
          `UPDATE ${USERS_TABLE}
           SET
             otp_attempts = $1,
             updated_at = NOW()
           WHERE id = $2`,
          [attempts, user.id]
        )

        await client.query('COMMIT')

        return res
          .status(400)
          .json({
            message:
              attempts >= OTP_MAX_ATTEMPTS
                ? 'Too many incorrect attempts. Request a new OTP'
                : 'Invalid OTP',
            attempts_remaining:
              Math.max(0, OTP_MAX_ATTEMPTS - attempts)
          })
      }

      const resetToken =
        jwt.sign(
          {
            purpose: 'password-reset',
            userId: user.id,
            email: cleanEmail,
            otpRef: getOtpReference(user.otp)
          },
          getPasswordResetSecret(),
          { expiresIn: '10m' }
        )

      await client.query(
        `UPDATE ${USERS_TABLE}
         SET
           otp_attempts = 0,
           updated_at = NOW()
         WHERE id = $1`,
        [user.id]
      )

      await client.query('COMMIT')

      return res.json({
        message:
          'OTP verified',
        reset_token: resetToken,
        expires_in: 600
      })
    } catch (err) {
      try {
        await client.query('ROLLBACK')
      } catch {}

      return res
        .status(500)
        .json({
          message:
            'Verification failed',
          error:
            err.message,
          detail:
            err.detail ||
            null,
          code:
            err.code ||
            null
        })
    } finally {
      client.release()
    }
  }
)

router.post(
  '/forgot/reset',
  async (req, res) => {
    const {
      reset_token,
      resetToken,
      newPassword
    } = req.body || {}

    const cleanResetToken =
      String(
        reset_token ||
          resetToken ||
          ''
      )
        .trim()

    const cleanNewPassword =
      String(
        newPassword ||
          ''
      ).trim()

    if (
      !cleanResetToken ||
      !cleanNewPassword
    ) {
      return res
        .status(400)
        .json({
          message:
            'Reset token and new password are required'
        })
    }

    if (
      cleanNewPassword.length <
      6
    ) {
      return res
        .status(400)
        .json({
          message:
            'Password must be at least 6 characters'
        })
    }

    let decoded

    try {
      decoded = jwt.verify(
        cleanResetToken,
        getPasswordResetSecret()
      )
    } catch {
      return res.status(400).json({
        message: 'Reset session is invalid or expired'
      })
    }

    if (
      decoded?.purpose !== 'password-reset' ||
      !decoded?.userId ||
      !decoded?.email ||
      !decoded?.otpRef
    ) {
      return res.status(400).json({
        message: 'Reset session is invalid or expired'
      })
    }

    const client = await pool.connect()

    try {
      await client.query('BEGIN')

      const result = await client.query(
        `SELECT id, email, otp, otp_expiry
         FROM ${USERS_TABLE}
         WHERE id = $1
           AND lower(email) = $2
         LIMIT 1
         FOR UPDATE`,
        [decoded.userId, String(decoded.email).trim().toLowerCase()]
      )

      const user = result.rows[0]
      const validSession =
        user &&
        user.otp &&
        user.otp_expiry &&
        new Date(user.otp_expiry).getTime() >= Date.now() &&
        getOtpReference(user.otp) === decoded.otpRef

      if (!validSession) {
        await client.query('ROLLBACK')
        return res.status(400).json({
          message: 'Reset session is invalid or expired'
        })
      }

      const hashedPassword = await bcrypt.hash(cleanNewPassword, 10)

      await client.query(
        `UPDATE ${USERS_TABLE}
         SET password = $1,
             otp = NULL,
             otp_expiry = NULL,
             otp_attempts = 0,
             otp_last_sent_at = NULL,
             updated_at = NOW()
         WHERE id = $2`,
        [hashedPassword, user.id]
      )

      await client.query('COMMIT')

      return res.json({
        message: 'Password updated successfully'
      })
    } catch (err) {
      try {
        await client.query('ROLLBACK')
      } catch {}

      return res.status(500).json({
        message: 'Password reset failed',
        error: err.message,
        detail: err.detail || null,
        code: err.code || null
      })
    } finally {
      client.release()
    }
  }
)

router.post(
  '/firebase-login',
  async (req, res) => {
    const {
      uid,
      email,
      name
    } = req.body || {}

    if (
      !uid ||
      !email
    ) {
      return res
        .status(400)
        .json({
          message:
            'uid and email are required'
        })
    }

    const cleanEmail =
      String(email)
        .trim()
        .toLowerCase()

    const displayName =
      String(
        name ||
          cleanEmail.split(
            '@'
          )[0] ||
          'User'
      ).trim()

    try {
      const client =
        await pool.connect()

      try {
        await client.query(
          'BEGIN'
        )

        const existing =
          await client.query(
            `SELECT
               id,
               name,
               email,
               mobile,
               type
             FROM ${USERS_TABLE}
             WHERE lower(email) = $1
             LIMIT 1`,
            [cleanEmail]
          )

        let user
        let isNewUser = false

        if (
          existing.rows.length >
          0
        ) {
          user =
            existing.rows[0]
        } else {
          const inserted =
            await client.query(
              `INSERT INTO ${USERS_TABLE}
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
                displayName,
                cleanEmail,
                '',
                '',
                'B2C'
              ]
            )

          user =
            inserted.rows[0]

          isNewUser = true
        }

        if (isNewUser) {
          await creditSignupBonus(
            user.id,
            client
          )
        }

        await client.query(
          'COMMIT'
        )

        const token =
          signToken(user)

        return res.json({
          token,
          user: {
            id:
              user.id,
            name:
              user.name,
            email:
              user.email,
            mobile:
              user.mobile,
            type:
              user.type ||
              'B2C'
          }
        })
      } catch (err) {
        await client.query(
          'ROLLBACK'
        )

        return res
          .status(500)
          .json({
            message:
              'Server error',
            error:
              err.message,
            detail:
              err.detail ||
              null,
            code:
              err.code ||
              null
          })
      } finally {
        client.release()
      }
    } catch (err) {
      return res
        .status(500)
        .json({
          message:
            'Server error',
          error:
            err.message,
          detail:
            err.detail ||
            null,
          code:
            err.code ||
            null
        })
    }
  }
)

module.exports = router
