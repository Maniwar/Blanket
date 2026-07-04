/*
 * concierge-kb.js — client-side knowledge base for the Feierabend concierge.
 * Plain browser script, no modules, no dependencies.
 *
 * Sets window.FEIER_KB = {
 *   images:    { token: { src, alt } }            — image tokens usable as {{img:token}}
 *   suggested: { sectionId: [q1, q2, q3], default: [...] }
 *              — three short shopper questions per page section (ids without '#')
 *   demo:      [ { match: [lowercase keywords], answer: 'markdown string' }, ... ]
 *              — canned answers; first entry whose keywords hit the query wins.
 *              Answers may embed images only as a line reading {{img:token}}.
 *   greeting:  markdown string — the concierge's opening message
 * }
 */
(function () {
  'use strict';

  window.FEIER_KB = {
    images: {
      'pack-wide': {
        src: 'img/pack-wide.webp',
        alt: 'Open forest-green rigid box: twill-wrapped blanket, beeswax seal, register card'
      },
      'pack-seal': {
        src: 'img/pack-seal.webp',
        alt: 'Beeswax seal pressed with the mill stamp beside the hand-tied knot'
      },
      'hero': {
        src: 'frames/hero/f001.webp',
        alt: 'Decke 01 in loden green, deep sculptural folds in low light'
      }
    },

    suggested: {
      hero: [
        'What makes Decke 01 different?',
        'How much does it cost?',
        'What is it made of?'
      ],
      why: [
        'Why only 15,000 a year?',
        'Who is Weberei Brandt?',
        'Is it worth $589?'
      ],
      wool: [
        'Is the merino mulesing-free?',
        'Will it be too hot?',
        'How heavy is it?'
      ],
      label: [
        'How do I wash it?',
        'Can it go in the dryer?',
        'What if it gets damaged?'
      ],
      ritual: [
        'How is it packaged?',
        'Is it good as a gift?',
        'What is the beeswax seal?'
      ],
      arrival: [
        'How long does delivery take?',
        'Are duties included?',
        'Does it ship in plastic?'
      ],
      reserve: [
        'What does the 30-night trial cover?',
        'How do returns work?',
        'What is lifetime mending?'
      ],
      'default': [
        'What are the full specs?',
        'How does it compare to Pendleton?',
        'Which colorways are there?'
      ]
    },

    demo: [
      {
        match: ['cancel', 'cancellation'],
        answer: 'On the live register, I list your cancellable orders and you tap the one to strike \u2014 its number returns to the year\u2019s edition. In this demonstration there is no register behind me, but the gesture looks like this:\n\n{{reply:Yes, cancel N\u00ba 14,214}}\n{{reply:Keep N\u00ba 14,214}}\n\nOnce weaving begins, the cloth carries your number \u2014 then the 30-night trial takes over instead.'
      },
      {
        match: ['my order', 'my blanket', 'order status', 'my deliveries', 'where is my', 'track', 'tracking', 'delivery status', 'status of my'],
        answer: 'The register can tell you exactly — each of your numbers, each with its own status — once it knows it is you. Sign in and I will read your entries back to you.\n\n{{action:signin}}\n\nFor changes or cancellations, write hello@feierabend.example.'
      },
      {
        match: ['buy', 'checkout', 'purchase', 'order one', 'get one', 'commission', 'reserve', 'want one', 'take my money', 'sign me up', 'how do i order'],
        answer: 'The commission takes about a minute. You choose your cloth, leave four details for the register — name, email, city, state — and your number is assigned at the mill. No payment is taken; this is a concept demonstration, and nothing will ship.\n\n{{action:commission}}\n\nI will be here when you return.'
      },
      {
        match: ['price', 'cost', 'how much', 'expensive', 'per year', 'value', 'afford'],
        answer: '**$589**, duties and U.S. delivery included. No import fees at the door, no surprises at checkout.\n\nThe more useful number: Decke 01 is built for the fifty years it takes to become someone else’s. Across that span it works out to about **twelve dollars a year**. If it ever needs repair, Weberei Brandt mends it for life, which keeps the arithmetic honest. A blanket like this isn’t replaced. It’s inherited.'
      },
      {
        match: ['spec', 'specs', 'dimensions', 'size', 'how big', 'measurements', 'weight', 'gsm', 'details'],
        answer: 'The full sheet, briefly.\n\n| Spec | Decke 01 |\n| --- | --- |\n| Size | 55 × 79 in (140 × 200 cm) |\n| Weight | 3.1 lb (1.4 kg) |\n| Fabric | 480 g/m² dense 2/2 twill, teasel-raised |\n| Fiber | 80% mulesing-free merino, 20% GOTS organic cotton |\n| Synthetics | None. Zero polyester |\n| Certification | OEKO-TEX Standard 100 Class I (infant-textile grade) |\n\nGenerous for one adult, correct at the foot of a queen bed. Woven at about four yards an hour, which is not a typo.'
      },
      {
        match: ['material', 'materials', 'merino', 'mulesing', 'wool', 'cotton', 'polyester', 'synthetic', 'fiber', 'organic'],
        answer: '**80% mulesing-free merino, 20% GOTS organic cotton. Zero polyester.** Nothing in Decke 01 comes from a barrel of oil.\n\nThe merino carries the warmth; the organic cotton steadies the weave. The cloth is a dense **480 g/m² 2/2 twill**, then raised with actual teasel heads for the nap — a slower method the mill has declined to modernize. The finished blanket is certified **OEKO-TEX Standard 100 Class I**, the infant-textile grade, so it is tested strictly enough to sleep a newborn under.'
      },
      {
        match: ['wash', 'washing', 'care', 'clean', 'dryer', 'laundry', 'machine', 'maintain'],
        answer: 'Care is deliberately short.\n\n- **Cold wool cycle**, 86°F (30°C), wool-safe detergent\n- **Line dry.** No tumble dryer, ever\n- **Wash it less than you think.** Wool self-cleans; an afternoon of fresh air fixes most things\n\nBecause the twill is plant-dyed or undyed, harsh detergents and hot water are the only real enemies. Treat it plainly and it will outlast your washing machine — several of them, in fact. If something does go wrong, the mill mends it for life.'
      },
      {
        match: ['ship', 'shipping', 'delivery', 'deliver', 'duties', 'customs', 'import', 'how long', 'when will it arrive', 'arrive'],
        answer: 'Each blanket is **woven to order** in the Allgäu, so allow **3–5 weeks to your door**. The mill weaves about four yards an hour and sees no reason to hurry.\n\n- **Duties and U.S. delivery are included** in the $589. Nothing owed at the door\n- It ships wrapped in **cotton twill, never plastic**\n- It arrives in the forest-green rigid box, sealed in beeswax, with your numbered register card\n\nOrder-specific questions — tracking, address changes — go to hello@feierabend.example.'
      },
      {
        match: ['return', 'returns', 'refund', 'trial', '30 night', '30-night', 'send it back', 'money back'],
        answer: 'You have a **30-night trial**. Sleep under it properly — that is the point.\n\nIf it isn’t right, return it **clean** within the 30 nights for a **full refund**. No restocking fee, no interrogation. We ask only that it comes back in the condition a future owner would want it in, since a returned blanket is inspected at the mill before anything else happens.\n\nIn practice, few come back. Wool this dense makes its own argument by the second week.'
      },
      {
        match: ['mend', 'mending', 'repair', 'lifetime', 'warranty', 'guarantee', 'moth', 'hole', 'damage', 'tear'],
        answer: '**Mended by the mill, for life.** Not a marketing lifetime — yours, and then the next owner’s.\n\nIf Decke 01 develops a hole, a pulled thread, or a moth’s bad decision, send it to Weberei Brandt and it comes back rewoven by the same hands that made it, on the same looms. Your serial number in the Webbuch tells them exactly which cloth, which dye lot, which weaver.\n\nThis is the quiet half of the price: you are not buying a blanket so much as a standing appointment with its maker.'
      },
      {
        match: ['number', 'numbered', 'serial', 'register', 'webbuch', 'edition', 'limited', '15,000', '15000'],
        answer: '**15,000 blankets a year. Never more.** That is roughly what the looms can produce at four yards an hour without cutting corners, so the edition size is set by physics, not marketing.\n\nEach blanket is **numbered on the selvedge** and entered by hand in the mill’s weave register — the **Webbuch**, kept continuously since 1897. Your copy of the entry arrives as a heavy register card carrying your number, your name, and the weaver’s initials. When the blanket is inherited, the number goes with it.'
      },
      {
        match: ['packaging', 'unbox', 'unboxing', 'box', 'gift', 'wrapped', 'wrapping', 'present', 'seal', 'beeswax'],
        answer: 'The unboxing is designed to be done slowly, once.\n\n- A **forest-green rigid box**, made to be kept\n- The blanket wrapped in **unbleached cotton twill**, tied by hand — no tape anywhere\n- A **beeswax seal** pressed with the 1897 stamp\n- A heavy **register card** with your number, your name, and the weaver’s initials\n\nNo plastic touches it at any point. As a gift it needs no additional wrapping; it would only be a step down.\n\n{{img:pack-wide}}'
      },
      {
        match: ['color', 'colors', 'colorway', 'colorways', 'dye', 'dyed', 'undyed', 'loden', 'graphit', 'ungefärbt', 'green', 'grey', 'gray'],
        answer: 'Three colorways, all of them honest.\n\n- **Ungefärbt** — undyed fleece, the wool as the sheep wore it\n- **Loden** — a deep green from alder bark\n- **Graphit** — a soft charcoal from walnut hulls\n\nUndyed or plant-dyed only; no synthetic dye has ever entered the mill’s vats. Plant dyes sit in the fiber rather than on it, so the colors read as depth instead of coating, and they age the way good leather does.\n\n{{img:hero}}'
      },
      {
        match: ['hot', 'too warm', 'overheat', 'sweat', 'temperature', 'thermoregulat', 'breathab', 'summer', 'cool'],
        answer: 'Reasonable worry, wrong material. **Wool thermoregulates** — it absorbs moisture vapor before you feel damp and releases warmth as the room changes, which is why the same fiber works on sheep in both January and July.\n\nDecke 01 is dense at **480 g/m²**, but the whole blanket is only **3.1 lb** and the teasel-raised nap traps air rather than heat. Hot sleepers generally do better under wool than under the polyester fills that cause the reputation. We make no medical claims. We do note that people stop kicking it off.'
      },
      {
        match: ['weighted', 'weighted blanket', 'glass bead', 'gravity', 'anxiety blanket', 'pressure'],
        answer: 'Different instruments. A **weighted blanket** runs around **20 lb** of glass beads sewn into polyester pockets, works through deep-pressure stimulation, and — most owners will admit — runs hot.\n\n**Decke 01** weighs **3.1 lb**, but the 480 g/m² twill distributes that weight with unusual evenness, so it settles rather than sits. You get the calm, grounded feeling without the heat, the beads, or the wrestling match at the laundromat. If you specifically need clinical deep pressure, buy the beads. If you want to sleep well under wool, this is the better decade-by-decade decision.'
      },
      {
        match: ['compare', 'comparison', 'competitor', 'pendleton', 'cashmere', 'hermès', 'hermes', 'loro piana', 'alternative', 'versus', 'vs', 'better than'],
        answer: 'A fair table, since you asked.\n\n| | Price | Material | Weight | Guarantee |\n| --- | --- | --- | --- | --- |\n| **Decke 01** | $589 | 80% mulesing-free merino, 20% GOTS cotton, zero polyester | 3.1 lb | 30-night trial, mended for life |\n| Pendleton | ~$300 | Wool blends, coarser hand, US-made | varies | standard warranty |\n| Weighted blanket | ~$100–300 | Polyester shell, glass beads | ~20 lb | varies |\n| Cashmere throw | $500–2,000 | Cashmere; softer but fragile, pills, dry-clean | ~1–2 lb | rarely any |\n\nPendleton is a fine brand. Hermès and Loro Piana are exquisite at 3–10× the price. Decke 01’s position is simpler: German mill provenance, zero synthetic, a number in the Webbuch, and a lifetime of mending — at $589.'
      },
      {
        match: ['mill', 'brandt', 'weberei', 'allgäu', 'allgau', 'bavaria', 'germany', 'german', '1897', 'who makes', 'family', 'history', 'story'],
        answer: '**Weberei Brandt** is a third-generation family mill in the **Allgäu**, in the Bavarian foothills, weaving since **1897**. The weave register — the Webbuch — has been kept by hand from the first bolt to yours.\n\nThe looms produce about **four yards an hour**. This is slow on purpose: the dense 2/2 twill needs low tension, and the nap is still raised with dried teasel heads rather than steel. Fifteen thousand blankets a year is what honest work at that pace yields, so that is the edition. Feierabend, if you were wondering, is the German word for the quiet hour after work ends.'
      },
      {
        match: ['worth', 'worth it', 'why so', 'justify', 'why 589', '$589', '589', 'too much', 'overpriced', 'cheap'],
        answer: 'Honest answer: it depends what you are comparing it to.\n\nAgainst a $60 polyester throw, no — different product, different decade. Against its actual peers: cashmere throws run **$500–2,000** and pill; Hermès and Loro Piana are beautiful at **3–10× the price**; nothing else at $589 offers **zero synthetic fiber, a numbered edition in a register kept since 1897, and lifetime mending by the mill**.\n\nBuilt for fifty years, it costs about **twelve dollars a year**, with a 30-night trial to check our math. That is the whole pitch. We find it tends to be enough.'
      }
    ],

    greeting: 'Good evening from the mill’s concierge. Ask me anything about **Decke 01** — the wool, the weave, the washing, or whether $589 is a reasonable thing to spend on a blanket (we have thoughts).'
  };
})();
