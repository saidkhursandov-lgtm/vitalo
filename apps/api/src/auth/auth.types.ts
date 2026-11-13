import type { Request } from 'express';
import type { users } from '@prisma/client';

export interface AuthContext {
  sessionId: string;
  user: users;
}

export interface AuthedRequest extends Request {
  auth?: AuthContext;
}

export interface UserProfile {
  id: string;
  telegram_user_id: number;
  first_name: string;
  last_name: string | null;
  username: string | null;
  phone: string | null;
  language: string;
  marketing_opt_in: boolean;
  /** 3.10-Б */
  review_requests: boolean;
  created_at: Date;
}

export function toUserProfile(u: users): UserProfile {
  return {
    id: u.id,
    telegram_user_id: Number(u.telegram_user_id), // Telegram ids fit in 52 bits -> safe as JS number
    first_name: u.first_name,
    last_name: u.last_name,
    username: u.username,
    phone: u.phone,
    language: u.language,
    marketing_opt_in: u.marketing_opt_in,
    review_requests: u.review_requests,
    created_at: u.created_at,
  };
}
