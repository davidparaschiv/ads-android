// @ts-check

export const demoBusinesses = [
  {
    id: 'atelier-luna',
    name: 'Atelier Luna',
    category: 'Salon de înfrumusețare',
    address: 'Str. Pictor Luchian 18, București',
    initials: 'AL',
    services: [
      { id: 'manichiura', name: 'Manichiură semipermanentă', duration: 60, resourceId: 'demo-calendar-1' },
      { id: 'pedichiura', name: 'Pedichiură', duration: 60, resourceId: 'demo-calendar-2' },
      { id: 'intretinere', name: 'Întreținere gel', duration: 90, resourceId: 'demo-calendar-3' },
    ],
  },
  {
    id: 'barber-11',
    name: 'Barber Eleven',
    category: 'Frizerie',
    address: 'Bd. Timișoara 44, București',
    initials: 'B11',
    services: [
      { id: 'tuns', name: 'Tuns', duration: 40, resourceId: 'barber-calendar-1' },
      { id: 'barba', name: 'Aranjat barbă', duration: 30, resourceId: 'barber-calendar-2' },
    ],
  },
  {
    id: 'lac-herastrau',
    name: 'Lacul Herăstrău Boats',
    category: 'Închiriere ambarcațiuni',
    address: 'Parcul Regele Mihai I, București',
    initials: 'LH',
    services: [
      { id: 'barca', name: 'Barcă cu vâsle', duration: 60, resourceId: 'boats-calendar-1' },
      { id: 'hidrobicicleta', name: 'Hidrobicicletă', duration: 60, resourceId: 'boats-calendar-2' },
    ],
  },
];

export const demoBookings = [
  { id: 'b1', business: 'Atelier Luna', service: 'Manichiură semipermanentă', customer: 'Ioana Pop', email: 'ioana@example.com', time: '09:00', duration:60, date: todayIso(), status: 'pending' },
  { id: 'b2', business: 'Atelier Luna', service: 'Pedichiură', customer: 'Maria Stan', email: 'maria@example.com', time: '11:00', duration:60, date: todayIso(), status: 'confirmed' },
  { id: 'b3', business: 'Atelier Luna', service: 'Întreținere gel', customer: 'Ana Radu', email: 'ana@example.com', time: '14:30', duration:90, date: todayIso(), status: 'confirmed' },
];

export function todayIso() {
  const date = new Date();
  const offset = date.getTimezoneOffset();
  return new Date(date.getTime() - offset * 60_000).toISOString().slice(0, 10);
}

export function futureDateIso(days = 1) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  const offset = date.getTimezoneOffset();
  return new Date(date.getTime() - offset * 60_000).toISOString().slice(0, 10);
}
