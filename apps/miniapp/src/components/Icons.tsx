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
  ShoppingBag,
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
export const CartIcon = make(ShoppingBag);
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
export const ShieldIcon = make(ShieldCheck);

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
