/** Admin icon set: Lucide, the same family as the Mini App. */
import { ArrowLeft, ArrowRight, Check, ChevronLeft, ChevronRight, Menu, Search, X, type LucideIcon, type LucideProps } from 'lucide-react';

const make = (C: LucideIcon) => {
  const I = (p: LucideProps) => <C size={16} strokeWidth={2} aria-hidden {...p} />;
  return I;
};

export const BackIcon = make(ArrowLeft);
export const ForwardIcon = make(ArrowRight);
export const PrevIcon = make(ChevronLeft);
export const NextIcon = make(ChevronRight);
export const CloseIcon = make(X);
export const SearchIcon = make(Search);
export const CheckIcon = make(Check);
export const MenuIcon = make(Menu);
