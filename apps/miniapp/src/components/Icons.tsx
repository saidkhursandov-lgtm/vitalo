/**
 * One icon set for the whole Mini App: Lucide (https://lucide.dev), same stroke everywhere.
 * Screens import icons only from here, so the set can be swapped in one place.
 */
import {
  Check,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  CircleX,
  ClipboardList,
  BadgeCheck,
  Bell,
  BellCheck,
  Bone,
  Brain,
  Droplet,
  Dumbbell,
  Fish,
  FlaskConical,
  Gem,
  Milk,
  HeartPulse,
  Leaf,
  Mars,
  Moon,
  Pill,
  ShieldPlus,
  Sparkle,
  Sparkles,
  Venus,
  CalendarClock,
  Clock,
  FileText,
  Gift,
  Phone,
  ShieldCheck,
  Copy,
  Heart,
  Hourglass,
  House,
  Info,
  LayoutGrid,
  MapPin,
  MessageCircle,
  Minus,
  Package,
  PackageCheck,
  Plus,
  Search,
  SearchX,
  ShoppingCart,
  Star,
  Stethoscope,
  SlidersHorizontal,
  Trash2,
  Truck,
  Undo2,
  User,
  WifiOff,
  X,
  type LucideIcon,
  type LucideProps,
} from 'lucide-react';

export type IconProps = LucideProps;
export type Icon = (p: IconProps) => React.JSX.Element;

const STROKE = 1.8;
const make = (C: LucideIcon): Icon => {
  const I = (p: IconProps) => <C strokeWidth={STROKE} aria-hidden {...p} />;
  return I;
};

export const HomeIcon = make(House);
export const GridIcon = make(LayoutGrid);
export const UserIcon = make(User);
/** Add-on v3.1: a trolley, not a bag (header, floating cart, buttons). */
export const CartIcon = make(ShoppingCart);
export const SearchIcon = make(Search);
export const SearchEmptyIcon = make(SearchX);
export const BackIcon = make(ChevronLeft);
export const ChevronIcon = make(ChevronRight);
export const FilterIcon = make(SlidersHorizontal);
export const TrashIcon = make(Trash2);
export const CopyIcon = make(Copy);
export const CheckIcon = make(Check);
export const CloseIcon = make(X);
export const MinusIcon = make(Minus);
export const PlusIcon = make(Plus);
export const OrdersIcon = make(ClipboardList);
export const PinIcon = make(MapPin);
export const OfflineIcon = make(WifiOff);
export const AlertIcon = make(CircleAlert);
export const InfoIcon = make(Info);
export const SupportIcon = make(MessageCircle);
export const GiftIcon = make(Gift);
export const PhoneIcon = make(Phone);
export const BadgeIcon = make(BadgeCheck);
export const StarIcon = ({ filled, ...p }: IconProps & { filled?: boolean }) => (
  <Star strokeWidth={STROKE} aria-hidden fill={filled ? 'currentColor' : 'none'} {...p} />
);
export const DoctorIcon = make(Stethoscope);
/** 2.4: «Сообщить о поступлении» / «Вы в списке ожидания» */
export const BellIcon = make(Bell);
export const BellCheckIcon = make(BellCheck);
/** 2.4: centre «Подбор» button */
export const SparkIcon = make(Sparkle);
export const ShieldIcon = make(ShieldCheck);
/** 2.3: «Стандарт VITALO» badges */
export const BioIcon = make(Droplet);
export const TestedIcon = make(FlaskConical);
export const LeafIcon = make(Leaf);

/**
 * Category icons on the home screen, by category slug (both trees). An unknown slug gets the neutral leaf,
 * so a category added in the admin panel never breaks the screen.
 */
export const CATEGORY_ICONS: Record<string, Icon> = {
  immunity: make(ShieldPlus),
  beauty: make(Sparkles),
  joints: make(Bone),
  // 2.2: «Энергия и мозг» (old «Энергия» and «Память» together)
  energy: make(Brain),
  sleep: make(Moon),
  heart: make(HeartPulse),
  memory: make(Brain),
  women: make(Venus),
  men: make(Mars),
  sport: make(Dumbbell),
  vitamins: make(Pill),
  minerals: make(Gem),
  omega: make(Fish),
  collagen: make(Droplet),
  'creatine-amino': make(FlaskConical),
  protein: make(Milk),
  other: make(Leaf),
};
export const categoryIcon = (slug: string): Icon => CATEGORY_ICONS[slug] ?? make(Leaf);

/** Home trust tiles. */
export const TRUST_ICONS: Record<'original' | 'delivery' | 'documents' | 'payments', Icon> = {
  original: make(ShieldCheck),
  delivery: make(Truck),
  documents: make(FileText),
  payments: make(CalendarClock),
};

export const HeartIcon = ({ filled, ...p }: IconProps & { filled?: boolean }) => (
  <Heart strokeWidth={STROKE} aria-hidden fill={filled ? 'currentColor' : 'none'} {...p} />
);

/** Order status icons (pill on the order screen and in the history). */
export const STATUS_ICONS: Record<string, Icon> = {
  new: make(Clock),
  awaiting_payment: make(Clock),
  checking: make(Hourglass),
  paid: make(CircleCheck),
  picking: make(Package),
  handed_to_delivery: make(Truck),
  in_transit: make(Truck),
  delivered: make(PackageCheck),
  cancelled: make(CircleX),
  return: make(Undo2),
};
