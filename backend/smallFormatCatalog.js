const SMALL_FORMAT_PRODUCTS = [
  'Book Printing',
  'Booklet Printing',
  'Bookmarks',
  'Brochures',
  'Business Cards',
  'Carbonless',
  'Catalogs',
  'Door Hangers',
  'Envelopes',
  'Flyers',
  'Greeting Cards & Invitations',
  'Labels/Stickers',
  'Laminating',
  'Letterhead',
  'Mailing Services',
  'Menus',
  'Newsletter',
  'Notebooks',
  'Pads',
  'Pocket Folders',
  'Postcards',
  'Programs',
  'Rack Cards',
  'Tickets',
];

const SMALL_FORMAT_PAPER = [
  '20# Bond',
  '24# Bond',
  '28# Bond',
  '60# Offset',
  '70# Text Gloss',
  '80# Text Gloss',
  '100# Text Gloss',
  '100# Text Matte',
  '80# Cover Gloss',
  '100# Cover Gloss',
  '100# Cover Matte',
  '12 pt Cover C2S',
  '14 pt Cover C2S',
  '16 pt Cover C2S',
  '14 pt Uncoated Cover',
  'Cardstock White',
  'Cardstock Colored',
  'Colored Paper',
  'Recycled',
  'NCR/Carbonless (2-part, 3-part, 4-part)',
  'Synthetic/Waterproof',
  'Adhesive Label Stock Gloss',
  'Adhesive Label Stock Matte',
  'Other (see notes)',
];

const SMALL_FORMAT_SIZES = [
  '8.5x11',
  '8.5x14',
  '11x17',
  '12x18',
  '13x19',
  '8.5x5.5',
  '5.5x4.25',
  '4x6',
  '5x7',
  '6x9',
  '3.5x2 (business card)',
  '3.5x8.5',
  '4x9 (rack card)',
  '3.67x8.5 (DL)',
  '9x12 (folder)',
  'Custom (enter in notes)',
];

// Colour modes already seeded on the process field. Sides/Color reuses those
// names instead of adding a second colour field.
const SMALL_FORMAT_COLOR_MODES = ['Black & White', 'Color'];

const SMALL_FORMAT_SIDES = [
  '4/4 full color both sides',
  '4/0 full color one side',
  '1/1 black both sides',
  '1/0 black one side',
  ...SMALL_FORMAT_COLOR_MODES,
];

const SMALL_FORMAT_BINDING = [
  'None',
  'Corner Staple',
  'Saddle Stitch',
  'Perfect Bound',
  'Spiral/Coil',
  'Wire-O',
  'Comb',
  '3-Ring Punch',
  'Tape Bound',
  'Padded (glued at top)',
  'Plastic Cover Wire',
  'Other',
];

const SMALL_FORMAT_FOLDING = [
  'None',
  'Half Fold',
  'Tri-Fold (letter)',
  'Z-Fold',
  'Gate Fold',
  'Double Parallel Fold',
  'Accordion Fold',
  'Roll Fold',
  'Cross Fold',
  'Custom (see notes)',
];

const SMALL_FORMAT_FINISHING = [
  'Cut/Trim',
  'Round Corners',
  'Drill (1 hole, 2 holes, 3 holes)',
  'Perforate',
  'Score',
  'Number',
  'Shrink Wrap',
  'Bundle',
  'Lamination Gloss',
  'Lamination Matte',
  'UV Coating',
  'Aqueous Coating',
  'Foil',
  'Die Cut',
  'Pads (glue)',
  'NCR Pad',
  'Bulk Mailing/EDDM',
  'Hand Fold',
  'Collate',
  'Fold',
  'Staple',
  'Padding',
];

const SMALL_FORMAT_PROOFS = [
  'None',
  'Digital Proof (PDF email)',
  'Hard Copy Proof',
  'Press Proof/Sample',
];

// Option lists written by the previous seed. An exact match, or an empty list,
// is treated as never edited and replaced. Anything else is an admin list.
const SMALL_FORMAT_PREVIOUS = {
  size: {
    label: 'Size',
    options: ['8.5x11', '8.5x14', '11x17', '12x18', 'See Note'],
  },
  media: {
    label: 'Media',
    options: [
      '20lb Standard Bond',
      '20lb Tree Zero',
      '28lb Color Laser',
      '65lb Matt Cover',
      '80lb Matt Cover',
      '70lb Gloss Text',
      '80lb Gloss Cover',
      'See Note',
    ],
  },
  sides: {
    label: 'Sides',
    options: ['1-Simplex', '2-Duplex'],
  },
  binding: {
    label: 'Binding',
    options: ['None', 'Cutting', 'GBC', 'Perfect', 'Spiral', 'Screw Post', 'Staple', '3HD', 'Binder', 'Wire-O'],
  },
  product: { label: 'Product', options: [] },
  folding: { label: 'Folding', options: [] },
  finishing: { label: 'Finishing', options: [] },
  proof: { label: 'Proof', options: [] },
};

module.exports = {
  SMALL_FORMAT_PRODUCTS,
  SMALL_FORMAT_PAPER,
  SMALL_FORMAT_SIZES,
  SMALL_FORMAT_COLOR_MODES,
  SMALL_FORMAT_SIDES,
  SMALL_FORMAT_BINDING,
  SMALL_FORMAT_FOLDING,
  SMALL_FORMAT_FINISHING,
  SMALL_FORMAT_PROOFS,
  SMALL_FORMAT_PREVIOUS,
};
