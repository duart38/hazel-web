// The first thing a new visitor sees: what Hazel is, the look live on the camera's back, and the
// four steps from an untouched camera to a developed photo. The steps tick off as the app sees
// them done. The pictures are one raw (B0000042) with its number plate blanked.

import { useEffect, useRef, useState, type ReactNode, type SyntheticEvent } from 'react'
import { model, useModel, type Place } from './model'
import { EdgePrint } from './ui/theme'

const LOOKS = [
  { slot: 'C1', name: 'Gold 200', file: 'gold-200' },
  { slot: 'C2', name: 'Faded chrome', file: 'faded-chrome' },
  { slot: 'C3', name: 'Warm portrait', file: 'warm-portrait' },
  { slot: 'C4', name: 'Red filter black and white', file: 'red-filter-black-and-white' },
  { slot: 'C5', name: 'Gritty black and white', file: 'gritty-black-and-white' },
  { slot: 'C6', name: 'Tungsten 800T', file: 'tungsten-800t' },
]
const screenOf = (file: string) => `/intro/screen-${file}.jpg`
const developedOf = (file: string) => `/intro/${file}-developed.jpg`

const FIRMWARE_REPO = 'https://github.com/duart38/Hazel-firmware'
const RECIPES_REPO = 'https://github.com/duart38/Hazel-film-recipes'

export function Start() {
  const state = useModel()
  const look = useLooks()
  const steps = useRef<HTMLElement>(null)
  const canInstall = typeof navigator !== 'undefined' && 'usb' in navigator
  const slotsFilled = Object.values(state.cardSlots ?? {}).filter(Boolean).length
  const go = (place: Place) => model.setPlace(place)

  return (
    <section className="screen intro" aria-labelledby="intro-title">
      <div className="scroll">
        <div className="intro-page">
          <header className="intro-hero">
            <EdgePrint tone="subtle">For the Hasselblad X1D-50c</EdgePrint>
            <h1 id="intro-title">
              Film simulations,
              <br />
              <em>live in camera.</em>
            </h1>
            <p className="intro-sub">Pick a look on the camera and see it in live view and the viewfinder while you shoot. Then develop the raws here with the same look.</p>
            <div className="intro-actions">
              <button type="button" className="button primary intro-big" onClick={() => steps.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>
                Get started
              </button>
              <button type="button" className="button intro-big" onClick={() => go('darkroom')}>
                Develop photos
              </button>
            </div>
          </header>

          <CameraBack look={look.current} />
          <div className="intro-chips" role="group" aria-label="Recipe on the camera">
            {LOOKS.map((l, i) => (
              <button key={l.slot} type="button" aria-pressed={look.index === i} onClick={() => look.pick(i)}>
                <b>{l.slot}</b>
                {l.name}
              </button>
            ))}
          </div>
          <p className="intro-caption">What the rear screen and the viewfinder show. Point at the eye sensor beside the viewfinder to switch between them.</p>

          <section ref={steps} className="intro-section" aria-labelledby="steps-title">
            <h2 id="steps-title">Getting started</h2>
            <p className="intro-lead">Four steps. The first one you do once.</p>
            <ol className="intro-steps">
              <Step n={1} title="Put Hazel on your camera" needs={['X1D-50c on firmware 1.25.0', 'Chrome or Edge on a computer', 'A memory card in the camera', 'Its USB-C cable']}>
                <p>
                  Connect the camera to this computer and press Install. It takes about half a minute. Nothing is flashed: Hazel runs from the memory card, and Remove Hazel takes it off again.
                </p>
                {canInstall ? (
                  <div className="row">
                    <button type="button" className="button safelight" onClick={() => go('camera')}>
                      Open the installer
                    </button>
                  </div>
                ) : (
                  <p className="intro-warning">
                    This browser can’t talk to the camera. Open this page in Chrome or Edge on a computer, or follow the Terminal steps on <a href={FIRMWARE_REPO}>GitHub</a>.
                  </p>
                )}
              </Step>
              <Step n={2} title="Choose your seven recipes" done={slotsFilled > 0} doneText={`${slotsFilled} of 7 slots filled on ${state.card?.name ?? 'the card'}`}>
                <p>
                  Browse the recipes and try them on a photo. Change one in the Studio if you like. Then put up to seven on the memory card, in slots C1 to C7. With the card in a card reader, a slot changes as soon as you pick a recipe for it.
                </p>
                <div className="row">
                  <button type="button" className="button" onClick={() => go('recipes')}>
                    Browse recipes
                  </button>
                  <button type="button" className="button" onClick={() => go('camera')}>
                    Fill the slots
                  </button>
                </div>
              </Step>
              <Step n={3} title="Shoot with a look">
                <p>
                  Turn the camera on. Hazel starts a few seconds after live view does. Choose a recipe in the menu under General Settings, Hazel, and fine-tune it with the wheels. Tap the recipe name on the screen to switch, also on a photo you already took.
                </p>
                <OnTheCamera />
              </Step>
              <Step n={4} title="Develop your photos" done={state.photos.length > 0} doneText={`${state.photos.length} photo${state.photos.length === 1 ? '' : 's'} open`}>
                <p>Open the card or a folder of raws in the Darkroom. Each photo opens with the look you shot it with. Change it, compare, and export. The raw file itself never changes.</p>
                <div className="row">
                  <button type="button" className="button primary" onClick={() => go('darkroom')}>
                    Open the Darkroom
                  </button>
                </div>
              </Step>
            </ol>
          </section>

          <section className="intro-section" aria-labelledby="develop-title">
            <h2 id="develop-title">Then develop it from the raw.</h2>
            <p className="intro-lead">The same look on the full raw file, here in the browser. Drag to compare.</p>
            <Compare look={look.current} />
          </section>

          <ul className="intro-points" aria-label="Good to know">
            <li>
              <h3>Nothing flashed</h3>
              <p>Hazel runs from the memory card. Without the card, the camera starts as it always did.</p>
            </li>
            <li>
              <h3>Comes off again</h3>
              <p>Remove Hazel on the Camera tab takes it off the camera and the card. Your photos stay.</p>
            </li>
            <li>
              <h3>Raws untouched</h3>
              <p>Each photo gets a small file next to it saying which look it was shot with. The raw stays as it was.</p>
            </li>
            <li>
              <h3>Tested on</h3>
              <p>The original X1D-50c on firmware 1.25.0, installed with Chrome on a Mac and with the Terminal steps.</p>
            </li>
          </ul>

          <section className="intro-section intro-why" aria-labelledby="why-title">
            <h2 id="why-title">Why I made this</h2>
            <div className="intro-story">
              <p>The X1D is an older camera now, and new features stopped coming a while ago. It still makes beautiful files, so I started adding some myself.</p>
              <p>Most days I reach for my Fujifilm instead, mainly for its film simulations. You choose a look and the camera applies it, so the photo comes out close to finished. I wanted the same on the X1D.</p>
              <p>What I like most is seeing the look before taking the picture. The viewfinder and rear screen show the colours and grain live, so you compose with the final image in front of you instead of editing it afterwards.</p>
              <p>Hazel is the result. If you have an X1D too, I hope it gets you using it more.</p>
            </div>
          </section>

          <footer className="intro-footer">
            <p>Not made by or affiliated with Hasselblad or Fujifilm.</p>
            <nav aria-label="Elsewhere">
              <a href={FIRMWARE_REPO}>Camera setup on GitHub</a>
              <a href={RECIPES_REPO}>Recipes on GitHub</a>
            </nav>
          </footer>
        </div>
      </div>
    </section>
  )
}

/** The chosen look, cycling through the six until someone picks one. */
function useLooks() {
  const [index, setIndex] = useState(0)
  const [picked, setPicked] = useState(false)
  useEffect(() => {
    for (const l of LOOKS) {
      new Image().src = screenOf(l.file)
      new Image().src = developedOf(l.file)
    }
  }, [])
  useEffect(() => {
    if (picked || matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const timer = window.setInterval(() => setIndex((i) => (i + 1) % LOOKS.length), 2600)
    return () => window.clearInterval(timer)
  }, [picked])
  return {
    index,
    current: LOOKS[index],
    pick: (i: number) => {
      setPicked(true)
      setIndex(i)
    },
  }
}

function Step(props: { n: number; title: string; done?: boolean; doneText?: string; needs?: string[]; children: ReactNode }) {
  return (
    <li className={`intro-step${props.done ? ' is-done' : ''}`}>
      <span className="intro-step-mark" aria-hidden="true">
        {props.done ? '✓' : props.n}
      </span>
      <div className="intro-step-body">
        <h3>
          <span className="visually-hidden">Step {props.n}: </span>
          {props.title}
        </h3>
        {props.done && props.doneText && <EdgePrint>{props.doneText}</EdgePrint>}
        {props.needs && (
          <ul className="intro-needs" aria-label="You need">
            {props.needs.map((need) => (
              <li key={need}>{need}</li>
            ))}
          </ul>
        )}
        {props.children}
      </div>
    </li>
  )
}

/** The X1D's back as a line drawing, only its screens lit. Like on the camera, an eye at the
 *  viewfinder turns the rear screen off and the viewfinder on. */
function CameraBack({ look }: { look: (typeof LOOKS)[number] }) {
  const [eye, setEye] = useState(false)
  const pressedWith = useRef('')
  const src = screenOf(look.file)
  return (
    <div className={`intro-camera${eye ? ' eye' : ''}`}>
      <svg viewBox="0 0 1200 790" aria-hidden="true">
        <path d="M86 86 L100 86 C100 40 122 14 176 14 L660 14 C714 14 736 40 736 86 L1118 86 Q1150 86 1150 118 L1150 734 Q1150 770 1114 770 L78 770 Q42 770 42 734 L42 130 Q42 86 86 86 Z" />
        <rect x="333" y="0" width="170" height="16" rx="4" />
        <circle cx="18" cy="150" r="11" />
        <circle cx="1182" cy="150" r="11" />
        <circle cx="142" cy="146" r="4.5" />
        <circle cx="158" cy="146" r="4.5" />
        <circle cx="174" cy="146" r="4.5" />
        <circle cx="683" cy="140" r="27" />
        <circle cx="768" cy="140" r="27" />
        <rect x="986" y="130" width="130" height="36" rx="18" />
        <rect x="66" y="200" width="714" height="564" rx="26" />
        {[230, 335, 444, 550, 658].map((y) => (
          <rect key={y} x="708" y={y} width="34" height="54" rx="9" />
        ))}
        <g className="grip">
          <rect x="798" y="200" width="346" height="542" rx="32" />
          {Array.from({ length: 14 }, (_, i) => (
            <line key={i} x1={826 + i * 22} y1="218" x2={826 + i * 22} y2="724" />
          ))}
        </g>
        <rect className="cup" x="220" y="42" width="396" height="203" rx="38" />
        <rect className="glass" x="352" y="92" width="130" height="104" rx="8" />
        <rect className="sensor" x="535" y="118" width="20" height="46" rx="10" />
      </svg>
      <div className="intro-screen">
        <img src={src} alt={`The camera's rear screen showing an old black car in a street full of autumn leaves, with the ${look.name} look`} />
      </div>
      <div className="intro-evf">
        <img src={src} alt="" />
      </div>
      <button
        type="button"
        className="intro-eye-sensor"
        aria-pressed={eye}
        aria-label="Eye sensor: look through the viewfinder"
        // a mouse switches by hovering; a tap or the keyboard toggles, since they can't hover
        onPointerEnter={(e) => e.pointerType === 'mouse' && setEye(true)}
        onPointerLeave={(e) => e.pointerType === 'mouse' && setEye(false)}
        onPointerDown={(e) => (pressedWith.current = e.pointerType)}
        onClick={() => {
          if (pressedWith.current !== 'mouse') setEye((on) => !on)
          pressedWith.current = ''
        }}
        onBlur={() => setEye(false)}
      />
    </div>
  )
}

function Compare({ look }: { look: (typeof LOOKS)[number] }) {
  const [split, setSplit] = useState(50)
  return (
    <div className="intro-compare" style={{ ['--split' as string]: `${split}%` }}>
      <img className="intro-shot" src="/intro/photo-as-shot.jpg" alt="The front of an old black car with autumn leaves on its bonnet, as the camera shot it" />
      <img className="intro-shot intro-after" src={developedOf(look.file)} alt={`The same photo developed with ${look.name}`} />
      <div className="intro-handle" />
      <span className="intro-tag left">As shot</span>
      <span className="intro-tag right">{look.name}</span>
      <input id="intro-split" type="range" min="0" max="100" value={split} onChange={(e) => setSplit(Number(e.target.value))} aria-label={`Compare the photo as shot with ${look.name}`} />
    </div>
  )
}

/** One of the camera's screens with numbered arrows: each points from its number at [tail] to the
 *  thing at [tip], in the screen's own 640 x 480 pixels. */
interface Screen {
  title: string
  file: string
  alt: string
  notes: { text: string; tail: [number, number]; tip: [number, number] }[]
}

const SCREENS: Screen[] = [
  {
    title: 'Find Hazel in the menu',
    file: 'menu',
    alt: "The camera's General Settings list: Wi-Fi, Display, Hazel, Touch",
    notes: [{ text: 'Press Menu, tap the gear for General Settings, then Hazel.', tail: [430, 292], tip: [262, 292] }],
  },
  {
    title: 'Switch it on',
    file: 'switches',
    alt: "Hazel's settings page: Film look, Recipe name and Temperature readout, all ticked",
    notes: [
      { text: 'Film look: the look in live view and on your photos. Untick it for the camera’s own picture.', tail: [490, 196], tip: [396, 196] },
      { text: 'Recipe name: shows which recipe is in use, on screen while you shoot.', tail: [490, 291], tip: [396, 291] },
      { text: 'Temperature readout: the image chip and sensor temperatures, at the top of live view.', tail: [490, 384], tip: [396, 384] },
    ],
  },
  {
    title: 'Pick a recipe',
    file: 'slots',
    alt: "Hazel's recipe slots: C2 Red filter black and white, C3 Warm portrait, C4 Silver screen, C5 Gold 200 ticked",
    notes: [
      { text: 'Your seven slots, C1 to C7: the recipes on the memory card.', tail: [490, 198], tip: [396, 198] },
      { text: 'The tick is the recipe in use. Tap another slot to switch.', tail: [490, 384], tip: [396, 384] },
    ],
  },
  {
    title: 'Shoot with it',
    file: 'live-view',
    alt: 'Live view with the Gold 200 look, its name at the top right next to a sliders button',
    notes: [
      { text: 'The recipe in use. Tap its name to pick another one, also on a photo in playback.', tail: [560, 290], tip: [556, 168] },
      { text: 'The sliders button: change this recipe right here on the camera.', tail: [290, 236], tip: [408, 160] },
    ],
  },
  {
    title: 'Switch without the menu',
    file: 'picker',
    alt: 'The list of recipes over live view, with Gold 200 highlighted',
    notes: [{ text: 'Tapping the name opens your recipes. Scroll the list and tap the one you want.', tail: [575, 410], tip: [463, 300] }],
  },
  {
    title: 'Change a recipe',
    file: 'adjust-settings',
    alt: 'The settings of the Gold 200 recipe on the Colour tab, next to the live picture',
    notes: [
      { text: 'Pick a setting. Tone, Colour and Texture each have their own list.', tail: [430, 175], tip: [300, 122] },
      { text: 'Done: save it to its slot, save it as a new one, use it without saving, or throw the changes away.', tail: [430, 445], tip: [290, 445] },
    ],
  },
  {
    title: 'Turn the wheels',
    file: 'adjust-wheels',
    alt: 'Shadow tint over live view, with sliders for hue and amount',
    notes: [
      { text: 'The front wheel moves the first slider, here the hue.', tail: [290, 320], tip: [220, 388] },
      { text: 'The rear wheel moves the second, here the amount.', tail: [440, 300], tip: [528, 428] },
      { text: 'Hold your finger on the picture to see the saved recipe, for comparison.', tail: [330, 466], tip: [452, 466] },
    ],
  },
  {
    title: 'Name a new recipe',
    file: 'adjust-name',
    alt: 'A keyboard on the camera, with "Autumn teal" typed as the name of a recipe saved as new',
    notes: [
      { text: 'Saving as a new recipe asks for a name. It goes into a free slot and onto the card.', tail: [320, 112], tip: [196, 96] },
      { text: 'Save when the name is right.', tail: [408, 464], tip: [462, 444] },
    ],
  },
]

/** Step 3's walk through the camera's own screens, open to start with and folded on request. */
function OnTheCamera() {
  const [at, setAt] = useState(0)
  const [hover, setHover] = useState<number | null>(null)
  const screen = SCREENS[at]
  const move = (by: number) => {
    setHover(null)
    setAt((i) => (i + by + SCREENS.length) % SCREENS.length)
  }
  // all eight load while the section is open, so a screen and its arrows always change together
  const preload = (event: SyntheticEvent<HTMLDetailsElement>) => {
    if (event.currentTarget.open) for (const s of SCREENS) new Image().src = `/intro/camera-${s.file}.jpg`
  }
  return (
    <details className="intro-onscreen" open onToggle={preload}>
      <summary>
        <span className="intro-onscreen-arrow" aria-hidden="true">
          ▸
        </span>
        See it on the camera
        <span className="subtle small">{SCREENS.length} screens</span>
      </summary>
      <div className="intro-onscreen-body">
        <div className="intro-onscreen-head">
          <EdgePrint tone="subtle">{`${at + 1} of ${SCREENS.length}`}</EdgePrint>
          <h4>{screen.title}</h4>
        </div>
        <div className="intro-onscreen-grid">
          <figure className="intro-onscreen-picture" key={screen.file}>
            <img src={`/intro/camera-${screen.file}.jpg`} alt={screen.alt} width={640} height={480} />
            <svg viewBox="0 0 640 480" aria-hidden="true">
              {screen.notes.map((note, i) => (
                <Callout key={i} n={i + 1} tail={note.tail} tip={note.tip} faded={hover !== null && hover !== i} />
              ))}
            </svg>
          </figure>
          <ol className="intro-onscreen-notes">
            {screen.notes.map((note, i) => (
              <li key={i} onPointerEnter={() => setHover(i)} onPointerLeave={() => setHover(null)}>
                <span className="intro-onscreen-n" aria-hidden="true">
                  {i + 1}
                </span>
                <span>{note.text}</span>
              </li>
            ))}
          </ol>
        </div>
        <div className="row intro-onscreen-nav">
          <button type="button" className="button" onClick={() => move(-1)} aria-label="Previous screen">
            ←
          </button>
          <div className="intro-onscreen-dots">
            {SCREENS.map((s, i) => (
              <button key={s.file} type="button" aria-label={s.title} aria-current={i === at ? 'step' : undefined} onClick={() => (setHover(null), setAt(i))} />
            ))}
          </div>
          <button type="button" className="button" onClick={() => move(1)} aria-label="Next screen">
            →
          </button>
        </div>
      </div>
    </details>
  )
}

function Callout({ n, tail, tip, faded }: { n: number; tail: [number, number]; tip: [number, number]; faded: boolean }) {
  const [x1, y1] = tail
  const [x2, y2] = tip
  const angle = Math.atan2(y2 - y1, x2 - x1)
  const length = Math.hypot(x2 - x1, y2 - y1)
  // the line starts at the number's edge and stops short of the tip, where the head takes over
  const from = [x1 + Math.cos(angle) * 17, y1 + Math.sin(angle) * 17]
  const to = [x2 - Math.cos(angle) * 10, y2 - Math.sin(angle) * 10]
  const head = [0, -9, 9].map((spread) => {
    const a = angle + Math.PI + (spread * Math.PI) / 60
    const r = spread === 0 ? 0 : 18
    return `${x2 + Math.cos(a) * r},${y2 + Math.sin(a) * r}`
  })
  return (
    <g className={`intro-callout${faded ? ' faded' : ''}`}>
      {length > 30 && (
        <>
          <line className="under" x1={from[0]} y1={from[1]} x2={to[0]} y2={to[1]} />
          <line x1={from[0]} y1={from[1]} x2={to[0]} y2={to[1]} />
        </>
      )}
      <polygon className="head" points={head.join(' ')} />
      <circle cx={x1} cy={y1} r={15} />
      <text x={x1} y={y1}>
        {n}
      </text>
    </g>
  )
}
