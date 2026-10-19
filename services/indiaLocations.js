const states = require('../data/india-states.json');
const key = value => String(value || '').toLowerCase().replace(/[^a-z]/g, '');
const aliases = { ap: 'Andhra Pradesh', ts: 'Telangana', od: 'Odisha', orissa: 'Odisha', uttaranchal: 'Uttarakhand', pondicherry: 'Puducherry', nctdelhi: 'Delhi', nctofdelhi: 'Delhi', newdelhi: 'Delhi', nationalcapitalterritoryofdelhi: 'Delhi', andamannicobarislands: 'Andaman and Nicobar Islands', jammukashmir: 'Jammu and Kashmir', dadraandnagarhaveli: 'Dadra and Nagar Haveli and Daman and Diu', damananddiu: 'Dadra and Nagar Haveli and Daman and Diu', dadraandnagarhavelianddamananddiu: 'Dadra and Nagar Haveli and Daman and Diu' };
function canonicalState(value) {
  return states.find(state => key(state) === key(value)) || aliases[key(value)] || '';
}
const validPin = value => /^[1-9]\d{5}$/.test(String(value || ''));
module.exports = { states, canonicalState, validPin };
