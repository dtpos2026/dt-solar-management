import '@fontsource-variable/inter'
import './splash.css'

const messages = [
  'Starting secure offline workspace…',
  'Opening your business database…',
  'Verifying license…',
  'Loading solar projects & inventory…',
  'Almost ready…'
]
let i = 0
const el = document.getElementById('status')
setInterval(() => {
  i = Math.min(i + 1, messages.length - 1)
  if (el) {
    el.classList.remove('fade')
    void el.offsetWidth
    el.textContent = messages[i]
    el.classList.add('fade')
  }
}, 650)
