const logger = require('../../logger');
const { getPhone } = require('./btPhone');

// The DB API socket of the head unit (port 2766), `pb` (phone book) part: the contacts and the call
// history of the virtual phone. The GUI opens a database, then asks for lists page by page.

// CallHistory entry direction -> the GUI's category.
const CATEGORY = { dialed: 'Dialled', received: 'Received', missed: 'Missed' };

function response(request, params) {
    const content = request.msgContent;
    return {
        msgType: 'methodResponse',
        msgContent: {
            api: content.api,
            methodName: content.methodName,
            reqId: content.reqId,
            params: params
        }
    };
}

const OK = { eCode: 0 };
const FAILED = { eCode: 1 };

function page(list, params) {
    const offset = Math.max(0, Number(params.offset) || 0);
    const limit = Math.max(0, Number(params.limit) || list.length);
    const items = list.slice(offset, offset + limit);
    return { items: items, count: items.length, totalCount: list.length, offset: offset };
}

function callHistory(phone, params) {
    const wanted = params.category;
    const entries = phone.calls.history.filter((entry) => {
        if (wanted === 'Missed') return entry.direction === 'missed';
        if (wanted === 'Dialled' || wanted === 'Dialed') return entry.direction === 'dialed';
        if (wanted === 'Received') return entry.direction === 'received';
        return true; // LastAll
    });
    const found = page(entries, params);
    return {
        eCode: 0,
        count: found.count,
        totalCount: found.totalCount,
        offset: found.offset,
        callHistories: found.items.map((entry) => ({
            id: entry.id,
            number: entry.number,
            displayName: phone.phonebook.nameOf(entry.number),
            category: CATEGORY[entry.direction],
            timestamp: Math.floor(entry.at / 1000),
            duration: entry.duration
        }))
    };
}

function contactOf(contact) {
    return {
        contactId: contact.contactId,
        dbSeqNo: contact.dbSeqNo,
        firstName: contact.firstName,
        lastName: contact.lastName,
        displayName: contact.displayName,
        numbers: contact.numbers
    };
}

// Answers one request of the GUI. Returns the message to send back, or null for a message that
// is not a request.
function handleRequest(request, phone = getPhone()) {
    if (!request || request.msgType !== 'method' || !request.msgContent) {
        return null;
    }
    const params = request.msgContent.params && typeof request.msgContent.params === 'object' ? request.msgContent.params : {};
    logger.debug('dbapi', 'Request %s %s', request.msgContent.methodName, JSON.stringify(params));
    switch (request.msgContent.methodName) {
        case 'OpenContactsDb':
        case 'CloseContactsDb':
        case 'OpenCallHistoryDb':
        case 'CloseCallHistoryDb':
        case 'FreeContactObjectsByIds':
            return response(request, OK);
        case 'GetContacts': {
            const found = page(phone.phonebook.all(), params);
            return response(request, {
                eCode: 0,
                count: found.count,
                totalCount: found.totalCount,
                offset: found.offset,
                contacts: found.items.map(contactOf)
            });
        }
        case 'GetContactByMatchedNumber':
        case 'FindContactsByNumber': {
            const matches = phone.phonebook.matchNumber(params.number);
            // no match: the call screen then shows the number
            return response(
                request,
                matches.length === 0 ? FAILED : { eCode: 0, contacts: matches.map(contactOf) }
            );
        }
        case 'GetContactDetails': {
            const contact = phone.phonebook.byId(params.contactId);
            return response(request, contact ? Object.assign({ eCode: 0 }, contactOf(contact)) : FAILED);
        }
        case 'GetCallHistory':
            return response(request, callHistory(phone, params));
        default:
            logger.debug('dbapi', 'Unsupported method %s', request.msgContent.methodName);
            return response(request, FAILED);
    }
}

module.exports = { handleRequest };
