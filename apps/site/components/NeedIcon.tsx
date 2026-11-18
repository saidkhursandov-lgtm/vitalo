import { Activity, Apple, Bone, Brain, Dumbbell, Flower2, HeartPulse, Leaf, Moon, ShieldCheck, Sparkles, User, Zap } from 'lucide-react';

const MAP: Record<string, typeof Leaf> = {
  sleep: Moon,
  immunity: ShieldCheck,
  joints: Bone,
  energy: Zap,
  beauty: Sparkles,
  women: Flower2,
  heart: HeartPulse,
  memory: Brain,
  men: User,
  sport: Dumbbell,
  digestion: Apple,
};

/** An icon for a «need» category by its slug; an unknown slug gets a leaf. */
export function NeedIcon({ slug, size = 24 }: { slug: string; size?: number }) {
  const Icon = MAP[slug] ?? (slug.includes('sport') ? Activity : Leaf);
  return <Icon size={size} strokeWidth={1.8} aria-hidden="true" />;
}
