-- Clients can sign in with a one-time code sent by email
ALTER TYPE "TokenType" ADD VALUE IF NOT EXISTS 'LOGIN_OTP';
