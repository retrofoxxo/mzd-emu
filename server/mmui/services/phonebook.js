// The contacts of the virtual phone (config/bluetooth.json), as the phone book the head unit
// downloads over Bluetooth (PBAP) and shows in Contacts, in the call history and on the call
// screens.

// Numbers are compared by their last digits, so +31 6 12 34 56 78 and 0612345678 match.
function digitsOf(number) {
    return String(number || '').replace(/\D/g, '');
}

function sameNumber(a, b) {
    const x = digitsOf(a);
    const y = digitsOf(b);
    if (x === '' || y === '') {
        return false;
    }
    const length = Math.min(9, x.length, y.length);
    return x.slice(-length) === y.slice(-length);
}

class Phonebook {
    constructor(contacts) {
        this.contacts = (contacts || [])
            .map((contact) => {
                const displayName = [contact.firstName, contact.lastName]
                    .filter((part) => part && String(part).trim() !== '')
                    .join(' ');
                return {
                    firstName: contact.firstName || '',
                    lastName: contact.lastName || '',
                    displayName: displayName,
                    numbers: (contact.numbers || []).map((entry) => ({
                        category: entry.category || 'Other',
                        number: String(entry.number)
                    }))
                };
            })
            .filter((contact) => contact.displayName !== '')
            .sort((a, b) => a.displayName.localeCompare(b.displayName))
            .map((contact, index) => Object.assign({ contactId: index + 1, dbSeqNo: 0 }, contact));
    }

    all() {
        return this.contacts;
    }

    byId(id) {
        return this.contacts.find((contact) => contact.contactId === Number(id)) || null;
    }

    // Every contact that has this number.
    matchNumber(number) {
        return this.contacts.filter((contact) =>
            contact.numbers.some((entry) => sameNumber(entry.number, number))
        );
    }

    nameOf(number) {
        const match = this.matchNumber(number)[0];
        return match ? match.displayName : '';
    }
}

module.exports = { Phonebook, sameNumber, digitsOf };
