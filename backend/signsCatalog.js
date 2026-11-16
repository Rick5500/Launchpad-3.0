const SIGNS_PRODUCTS = [
  'Yard Signs',
  'Construction Sign',
  'Banners',
  'Fence Screen',
  'Posters',
  'Window Graphics',
  'Vehicle Graphics',
  'Wall Graphics',
  'Displays',
  'Custom',
];

const SIGNS_EQUIPMENT = [
  'Flatbed',
  'CNC Router',
  'Large Format Roll Printer',
  'Vinyl Cutter',
  'Laminator',
  'Mounting Press',
];

const SIGNS_MOUNT = [
  'No',
  '3/16 Foam Core',
  '3/16 Gator Board',
  '1/2 Gator Board',
  '1/8 Sintra',
  '1/4 Sintra',
  '1/2 Sintra',
  'Coroplast',
  'See Notes',
];

const SIGNS_LAMINATE = ['No', 'Gloss', 'Matte', 'Dry Erase', 'Lexan', 'See Notes'];

const SIGNS_FINISHING = [
  'None',
  'Grommets',
  'Hems',
  'Pole Pockets',
  'Wind Slits',
  'Install',
  'Stakes',
  'Easel',
  'Cut/Trim',
  'Velcro',
  'Print Hanger',
  'Framing',
  'Contour Cut',
  'Routed Shape',
  'See Notes',
];

// Option lists written before this catalog change. An exact match is still the
// seed and is replaced. Anything else is treated as an admin's list.
const SIGNS_PREVIOUS = {
  product_type: {
    label: 'Product Type',
    options: [
      'Yard Signs', 'Banners', 'Posters', 'Window Graphics', 'Vehicle Graphics', 'Wall Graphics', 'Displays', 'Custom',
    ],
  },
  mount: {
    label: 'Mount',
    options: [
      'No', '3/16 Foam Core', '3/16 Gator Board', '1/2 Gator Board', '1/8 Sintra', '1/4 Sintra', '1/2 Sintra', 'Corplast', 'See Notes',
    ],
  },
  laminate: {
    label: 'Laminate',
    options: ['No', 'Gloss', 'Matt', 'Dry Erase', 'Lexan', 'See Notes'],
  },
  finishing: {
    label: 'Finishing',
    options: [
      'None', 'Grommets', 'Easel', 'Cut/Trim', 'Velcro', 'Print Hanger', 'Framing', 'Contour Cut', 'Routed Shape', 'See Notes',
    ],
  },
};

module.exports = {
  SIGNS_PRODUCTS,
  SIGNS_EQUIPMENT,
  SIGNS_MOUNT,
  SIGNS_LAMINATE,
  SIGNS_FINISHING,
  SIGNS_PREVIOUS,
};
