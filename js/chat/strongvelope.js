/**
 * @fileOverview
 * Simplistic, group capable encryption module for chat messages.
 */

/**
 * @description
 * <p>Simplistic, group capable encryption module for chat messages.</p>
 *
 * <p>
 * Encrypts a chat message using AES with a symmetric key derived
 * using Curve25519. Messages are signed using Ed25519. Messages are encoded
 * in a binary TLV transport format,</p>
 */
var strongvelope = {};

(function () {
    "use strict";

    var ns = strongvelope;

    var logger = MegaLogger.getLogger('strongvelope', undefined, 'chat');
    strongvelope._logger = logger;

    var NONCE_SIZE = 12;
    strongvelope.NONCE_SIZE = NONCE_SIZE;
    var KEY_SIZE = 16;
    strongvelope.KEY_SIZE = KEY_SIZE;
    var IV_SIZE = 16;
    strongvelope.IV_SIZE = IV_SIZE;


    /** Version of the protocol implemented. */
    var PROTOCOL_VERSION = 0x00;
    strongvelope.PROTOCOL_VERSION = PROTOCOL_VERSION;

    /** After how many messages our symmetric sender key is rotated. */
    strongvelope.ROTATE_KEY_EVERY = 16;


    /** Size (in bytes) of the secret/symmetric encryption key. */
    var SECRET_KEY_SIZE = 16;
    strongvelope.SECRET_KEY_SIZE = SECRET_KEY_SIZE;


    /**
     * "Enumeration" of TLV types used for the chat message transport container.
     *
     * Note: The integer value of the TLV type also indicates the allowed order
     *       within a message encoding. Values must be monotonically increasing
     *       within, but single record types may be skipped. `RECIPIENT` and
     *       `KEYS` are the only types that may (concurrently) be repeated.
     *
     * @property _UNUSED_SEPARATOR_ {Number}
     *     NULL is used as a terminator for the record type. Don't use!
     * @property SIGNATURE {Number}
     *     Payload signature for all following bytes.
     * @property MESSAGE_TYPE {Number}
     *     Type of message sent.
     * @property NONCE {Number}
     *     "Base nonce" used for encryption (individual nonces are derived from
     *     it).
     * @property RECIPIENT {Number}
     *     Recipient of message. This record can be repeated for all recipients
     *     of message.
     * @property KEYS {Number}
     *     Message encryption keys, encrypted to a particular recipient. This
     *     may contain two (concatenated) keys. The second one (if present) is
     *     the previous sender key (key ID one less). Requires
     *     the sane number of records in the same order as `RECIPIENT`.
     * @property KEY_ID {Number}
     *     Sender encryption key ID used (or set) in this message. Must be an
     *     integer incremented for every new key used.
     * @property PAYLOAD {Number}
     *     Encrypted payload of message.
     */
    var TLV_TYPES = {
        _UNUSED_SEPARATOR_: 0x00,
        SIGNATURE:          0x01,
        MESSAGE_TYPE:       0x02,
        NONCE:              0x03,
        RECIPIENT:          0x04,
        KEYS:               0x05,
        KEY_ID:             0x06,
        PAYLOAD:            0x07,
    };
    strongvelope.TLV_TYPES = TLV_TYPES;


    // Mapping of TLV_TYPES to object attribute names (used in message parser.)
    // Note: These must be manually updated to reflect TLV_TYPES.
    var _TLV_MAPPING = {
        0x01: 'signature',
        0x02: 'type',
        0x03: 'nonce',
        0x04: 'recipients',
        0x05: 'keys',
        0x06: 'keyId',
        0x07: 'payload',
    };


    /**
     * "Enumeration" of message types used for the chat message transport.
     *
     * @property GROUP_KEYED {Number}
     *     Data message containing a new sender key (initial or key rotation).
     * @property GROUP_CONTINUE {Number}
     *     Data message using an existing sender key for encryption.
     * @property SIMPLE_TWO_PARTY {Number}
     *     Data message without transfer of a symmetric encryption key (using
     *     shared DH secret and nonce only).
     */
    var MESSAGE_TYPES = {
        GROUP_KEYED:        0x00,
        GROUP_FOLLOWUP:     0x01,
        SIMPLE_TWO_PARTY:   0x02,
    };
    strongvelope.MESSAGE_TYPES = MESSAGE_TYPES;


    /**
     * Encrypts a message symmetrically using AES-128-CTR. The object returned
     * contains the key and nonce used.
     *
     * Note: Nonces longer than the used NONCE_SIZE bytes are truncated.
     *
     * @param message {String}
     *     Plain text message.
     * @param key {String}
     *     Symmetric encryption key in a binary string. If omitted, a fresh
     *     key will be generated.
     * @param nonce {String}
     *     Nonce to encrypt a message with in a binary string. If omitted, a
     *     fresh nonce will be generated.
     * @returns {Object}
     *     Object containing the cipher text (in attribute `ciphertext`), the
     *     key (attribute `key`) and the nonce (attribute `nonce`) used.
     * @private
     */
    strongvelope._symmetricEncryptMessage = function(message, key, nonce) {

        var result = { ciphertext: null, key: null, nonce: null };
        var nonceBytes;
        var keyBytes;

        if (key) {
            keyBytes = asmCrypto.string_to_bytes(key);
        }
        else {
            keyBytes = new Uint8Array(KEY_SIZE);
            asmCrypto.getRandomValues(keyBytes);
        }

        if (nonce) {
            nonceBytes = asmCrypto.string_to_bytes(nonce.substring(0, NONCE_SIZE));
        }
        else {
            nonceBytes = new Uint8Array(NONCE_SIZE);
            asmCrypto.getRandomValues(nonceBytes);
        }

        var clearBytes = asmCrypto.string_to_bytes(unescape(encodeURIComponent(message)));
        var cipherBytes = asmCrypto.AES_CTR.encrypt(clearBytes, keyBytes, nonceBytes);

        result.ciphertext = asmCrypto.bytes_to_string(cipherBytes);
        result.key = asmCrypto.bytes_to_string(keyBytes);
        result.nonce = asmCrypto.bytes_to_string(nonceBytes);

        return result;
    };


    /**
     * Decrypts a message symmetrically using AES-128-CTR.
     *
     * Note: Nonces longer than the used NONCE_SIZE bytes are truncated.
     *
     * @param cipher {String}
     *     Message in cipher text.
     * @param key {String}
     *     Symmetric encryption key in a binary string.
     * @param nonce {String}
     *     Nonce to decrypt a message with in a binary string.
     * @returns {String}
     *     Clear text of message content.
     * @private
     */
    strongvelope._symmetricDecryptMessage = function(cipher, key, nonce) {

        var keyBytes = asmCrypto.string_to_bytes(key);
        var nonceBytes = asmCrypto.string_to_bytes(nonce.substring(0, NONCE_SIZE));
        var cipherBytes = asmCrypto.string_to_bytes(cipher);
        var clearBytes = asmCrypto.AES_CTR.decrypt(cipherBytes, keyBytes, nonceBytes);
        var clearBytes = asmCrypto.bytes_to_string(clearBytes);

        var clearText;
        try {
            clearText = decodeURIComponent(escape(clearBytes));
        }
        catch (e) {
            if (e instanceof URIError) {
                logger.error('Could not decrypt message, probably a wrong key/nonce.');

                return false;
            }
            else {
                throw e;
            }
        }

        return clearText;
    };


    /**
     * Signs a message using EdDSA with an Ed25519 key pair.
     *
     * @param message {String}
     *     Message to sign.
     * @param privKey {String}
     *     Ed25519 private key.
     * @param pubKey {String}
     *     Ed25519 public key.
     * @returns {String}
     *     Message signature.
     * @private
     */
    strongvelope._signMessage = function(message, privKey, pubKey) {

        var keyBytes = asmCrypto.string_to_bytes(privKey + pubKey);
        var messageBytes = asmCrypto.string_to_bytes(message);
        var signature = nacl.sign.detached(messageBytes, keyBytes);

        return asmCrypto.bytes_to_string(signature);
    };


    /**
     * Verifies a message using EdDSA with an Ed25519 key pair.
     *
     * @param message {String}
     *     Message to sign.
     * @param signature {String}
     *     Message signature.
     * @param pubKey {String}
     *     Ed25519 public key.
     * @returns {Boolean}
     *     Verification result.
     * @private
     */
    strongvelope._verifyMessage = function(message, signature, pubKey) {

        var messageBytes = asmCrypto.string_to_bytes(message);
        var signatureBytes = asmCrypto.string_to_bytes(signature);
        var keyBytes = asmCrypto.string_to_bytes(pubKey);

        return nacl.sign.detached.verify(messageBytes, signatureBytes, keyBytes);
    };


    /**
     * Parses the binary content of a message into an object. Content will not
     * be decrypted or signatures verified.
     *
     * @param {String} binaryMessage
     *     Binary message as transported.
     * @returns {(Object|Boolean)}
     *     Contains all message content decoded from binary transport format.
     *     Returns `false` in case of errors.
     */
    strongvelope._parseMessageContent = function(binaryMessage) {

        var parsedContent = { keys: [], recipients: [] };
        var currentTlvType = null;
        var part;
        var tlvType;
        var tlvVariable;
        var lastTlvType = -1;

        parsedContent.protocolVersion = binaryMessage.charCodeAt(0);
        var rest = binaryMessage.substring(1);

        while (rest.length > 0) {
            part = tlvstore.splitSingleTlvRecord(rest);
            tlvType = part.record[0].charCodeAt(0);
            tlvVariable = _TLV_MAPPING[tlvType];

            if (tlvType < lastTlvType) {
                logger.error('Received unexpected TLV type.');

                return false;
            }

            // Some records need different treatment. Let's go through cases.
            switch (tlvType) {
                case TLV_TYPES.SIGNATURE:
                    parsedContent[tlvVariable] = part.record[1];
                    parsedContent.signedContent = part.rest;
                    break;
                case TLV_TYPES.MESSAGE_TYPE:
                    parsedContent[tlvVariable] = part.record[1].charCodeAt(0);
                    break;
                case TLV_TYPES.RECIPIENT:
                    parsedContent[tlvVariable].push(base64urlencode(part.record[1]));
                    break;
                case TLV_TYPES.KEYS:
                    parsedContent[tlvVariable].push(part.record[1]);
                    break;
                case TLV_TYPES.KEY_ID:
                    parsedContent[tlvVariable] = part.record[1].charCodeAt(0);
                    break;
                default:
                    parsedContent[tlvVariable] = part.record[1];
            }

            rest = part.rest;
            lastTlvType = tlvType;
        }

        if ((parsedContent.recipients.length > 0)
                && (parsedContent.recipients.length !== parsedContent.keys.length)) {
            logger.error('Number of keys does not match number of recipients.');

            return false;
        }

        return parsedContent;
    };


    /**
     * An object containing a participant's secret key information. One of these
     * objects is used per participant. Each element within is indexed by the
     * participant's sender keyId, referencing a value of the symmetric sender
     * key.
     *
     * @typedef {Object} ParticipantKeys
     */


    /**
     * An object containing data of a successfully decrypted message..
     *
     * @typedef {Object} StrongvelopeMessage
     * @property {String} sender
     *     Sender user handle.
     * @property {Number} type
     *     Type of message.
     * @property {String} payload
     *     Message content/payload.
     */


    /**
     * Manages keys, encryption and message encoding.
     *
     * @constructor
     * @param {String} [ownHandle]
     *     Our own user handle (default: u_handle).
     * @param {String} [privCu25519]
     *     Our private chat key (Curve25519, default: u_privCu25519).
     * @param {String} [privEd25519]
     *     Our private signing key (Ed25519, default: u_pubCu25519).
     * @param {String} [pubEd25519]
     *     Our public signing key (Ed25519, optional, can be derived upon
     *     instantiation from private key).
     * @param {Number} [rotateKeyEvery=16]
     *     The number of messages our sender key is used for before rotating
     *     (default: strongvelope.ROTATE_KEY_EVERY).
     *
     * @param {String} ownHandle
     *     Our own user handle (u_handle).
     * @param {String} privCu25519
     *     Our private chat key (Curve25519).
     * @param {String} privEd25519
     *     Our private signing key (Ed25519).
     * @param {String} pubEd25519
     *     Our public signing key (Ed25519).
     * @property {Number} rotateKeyEvery
     *     The number of messages our sender key is used for before rotating.
     * @property {Number} keyId
     *     ID of our current sender key.
     * @property {Array.<String>} participants
     *     Array of user handles of current participants of the chat, sorted
     *     by user handle.
     * @property {Object.<handle, ParticipantKeys>} participantKeys
     *     Collection of participant specific key information (including our own,
     *     @see {@link ParticipantKey} for all (past and present) participants.
     */
    strongvelope.ProtocolHandler = function(ownHandle, privCu25519, privEd25519,
            pubEd25519, rotateKeyEvery) {

        this.ownHandle = ownHandle || u_handle;
        this.privCu25519 = privCu25519 || u_privCu25519;
        this.privEd25519 = privEd25519 || u_privEd25519;
        this.pubEd25519 = pubEd25519;
        if (!this.pubEd25519) {
            this.pubEd25519 = crypt.getPubKeyFromPrivKey(this.privEd25519, 'Ed25519');
        }
        this.rotateKeyEvery = rotateKeyEvery || strongvelope.ROTATE_KEY_EVERY;
        this._keyEncryptionCount = 0;
        this.keyId = 0;
        this._sentKeyId = null;
        var secretKey = new Uint8Array(SECRET_KEY_SIZE);
        asmCrypto.getRandomValues(secretKey);
        this.participants = [];
        this.participantKeys = {};
        this.participantKeys[this.ownHandle] = { 0: asmCrypto.bytes_to_string(secretKey) };
    };


    /**
     * Derives a symmetric key for encrypting a message to a contact.  It is
     * derived using a Curve25519 key agreement.
     *
     * Note: The Curve25519 key cache must already contain the public key of
     *       the recipient.
     *
     * @method
     * @param userhandle {String}
     *     Mega user handle for user to send to or receive from.
     * @return {String}
     *     Binary string containing a 256 bit symmetric encryption key.
     * @private
     */
    strongvelope.ProtocolHandler.prototype._computeSymmetricKey = function(userhandle) {
        var pubKey = pubCu25519[userhandle];
        if (!pubKey) {
            logger.error('No cached chat key for user: ' + userhandle);
            throw new Error('No cached chat key for user!');
        }
        var sharedSecret = nacl.scalarMult(
            asmCrypto.string_to_bytes(this.privCu25519),
            asmCrypto.string_to_bytes(pubKey));
        var key = asmCrypto.SHA256.bytes(sharedSecret);

        return asmCrypto.bytes_to_string(key);
    };


    /**
     * Encrypts symmetric encryption keys for a particular recipient.
     *
     * Note: This function requires the Cu25519 public key for the destination
     *       to be loaded already.
     *
     * @method
     * @param {Array.<String>} keys
     *     Keys to encrypt.
     * @param {String} nonce
     *     "Master nonce" used for encrypting the message. Will be used to
     *     derive an IV for the key encryption.
     * @param {String} destination
     *     User handle of the recipient.
     * @returns {String}
     */
    strongvelope.ProtocolHandler.prototype._encryptKeysFor = function(keys, nonce, destination) {

        assert(keys.length > 0, 'No keys to encrypt.');

        var clearText = '';
        for (var i = 0; i < keys.length; i++) {
            clearText += keys[i];
        }
        var clearBytes = asmCrypto.string_to_bytes(clearText);
        var ivBytes = asmCrypto.SHA256.bytes(base64urldecode(destination)
                                             + nonce).subarray(0, IV_SIZE);
        var keyBytes = asmCrypto.string_to_bytes(
            this._computeSymmetricKey(destination).substring(0, KEY_SIZE));
        var cipherBytes = asmCrypto.AES_CBC.encrypt(clearBytes, keyBytes,
                                                    false, ivBytes);

        return asmCrypto.bytes_to_string(cipherBytes);
    };


    /**
     * Decrypts symmetric encryption keys for a particular sender.
     *
     * Note: This function requires the Cu25519 public key for the destination
     *       to be loaded already.
     *
     * @method
     * @param {String} encryptedKeys
     *     Encrypted Key(s).
     * @param {String} nonce
     *     "Master nonce" used for encrypting the message. Will be used to
     *     derive an IV for the key decryption.
     * @param {String} otherParty
     *     User handle of the other party.
     * @param {Boolean} [iAmSender]
     *     If true, the message was sent by us (default: false).
     * @returns {Array.<String>}
     *     All symmetric keys in an array.
     */
    strongvelope.ProtocolHandler.prototype._decryptKeysFor = function(
            encryptedKeys, nonce, otherParty, iAmSender) {

        var receiver = iAmSender ? otherParty : this.ownHandle;
        var cipherBytes = asmCrypto.string_to_bytes(encryptedKeys);
        var ivBytes = asmCrypto.SHA256.bytes(base64urldecode(receiver)
                                             + nonce).subarray(0, IV_SIZE);
        var keyBytes = asmCrypto.string_to_bytes(
            this._computeSymmetricKey(otherParty).substring(0, KEY_SIZE));
        var clearBytes = asmCrypto.AES_CBC.decrypt(cipherBytes, keyBytes,
                                                   false, ivBytes);
        var clear = asmCrypto.bytes_to_string(clearBytes);

        assert(clear.length % KEY_SIZE === 0,
               'Length mismatch for decoding sender keys.');

        var result = [];
        while (clear.length > 0) {
            result.push(clear.substring(0, KEY_SIZE));
            clear = clear.substring(KEY_SIZE);
        }

        return result;
    };


    /**
     * Encrypts a message to (currently just a single) recipient.
     *
     * @method
     * @param {String} message
     *     Data message to encrypt.
     * @param {String} destination
     *     User handle of the recipient.
     * @returns {String}
     */
    strongvelope.ProtocolHandler.prototype.encryptTo = function(message, destination) {

        var content = '';
        var encryptedKeys;
        var messageType;
        var previousKeyId = this.keyId;

        // Check and rotate key if due.
        if (this._keyEncryptionCount >= this.rotateKeyEvery) {
            var newSecretKey = new Uint8Array(SECRET_KEY_SIZE);
            asmCrypto.getRandomValues(newSecretKey);
            this.keyId = (this.keyId + 1) & 0xff;
            this.participantKeys[this.ownHandle][this.keyId] = asmCrypto.bytes_to_string(newSecretKey);
            this._keyEncryptionCount = 0;
        }

        var senderKey = this.participantKeys[this.ownHandle][this.keyId];
        var encryptedMessage = ns._symmetricEncryptMessage(message, senderKey);

        // Use a (leaner) followup message if the sender key's been sent already.
        if (this._sentKeyId === this.keyId) {
            messageType = MESSAGE_TYPES.GROUP_FOLLOWUP;
        }
        else {
            var keysIncluded = [senderKey];
            if (previousKeyId !== this.keyId) {
                keysIncluded.push(this.participantKeys[this.ownHandle][previousKeyId]);
            }
            encryptedKeys = this._encryptKeysFor(keysIncluded, encryptedMessage.nonce,
                                                 destination);
            messageType = MESSAGE_TYPES.GROUP_KEYED;
        }

        // Assemble message content.
        content += tlvstore.toTlvRecord(String.fromCharCode(TLV_TYPES.MESSAGE_TYPE),
                                        String.fromCharCode(messageType));
        content += tlvstore.toTlvRecord(String.fromCharCode(TLV_TYPES.NONCE),
                                        encryptedMessage.nonce);
        if (encryptedKeys) {
            // Include recipient(s) and sender key(s).
            content += tlvstore.toTlvRecord(String.fromCharCode(TLV_TYPES.RECIPIENT),
                                            base64urldecode(destination));
            content += tlvstore.toTlvRecord(String.fromCharCode(TLV_TYPES.KEYS),
                                            encryptedKeys);
            this._sentKeyId = this.keyId;
        }
        content += tlvstore.toTlvRecord(String.fromCharCode(TLV_TYPES.KEY_ID),
                                        String.fromCharCode(this.keyId));
        content += tlvstore.toTlvRecord(String.fromCharCode(TLV_TYPES.PAYLOAD),
                                        encryptedMessage.ciphertext);

        // Sign message.
        var signature = ns._signMessage(content,
                                        this.privEd25519, this.pubEd25519);
        content = tlvstore.toTlvRecord(String.fromCharCode(TLV_TYPES.SIGNATURE),
                                       signature)
                + content;

        this._keyEncryptionCount++;

        // Return assembled total message.
        return String.fromCharCode(PROTOCOL_VERSION) + content;
    };


    /**
     * Decrypts a message from a sender and (potentially) updates sender keys.
     *
     * @method
     * @param {String} message
     *     Data message to encrypt.
     * @param {String} sender
     *     User handle of the message sender.
     * @returns {(StrongvelopeMessage|Boolean)}
     *     The message content on success, `false` in case of errors.
     */
    strongvelope.ProtocolHandler.prototype.decryptFrom = function(message, sender) {

        var parsedMessage = ns._parseMessageContent(message);

        // Bail out on parse error.
        if (parsedMessage === false) {
            logger.error('Incoming message not usable.');

            return false;
        }

        // Verify protocol version.
        if (parsedMessage.protocolVersion !== PROTOCOL_VERSION) {
            logger.error('Message not compatible with current protocol version.');

            return false;
        }

        // Verify signature.
        if (!ns._verifyMessage(parsedMessage.signedContent,
                               parsedMessage.signature,
                               pubEd25519[sender])) {
            logger.error('Message signature invalid.');

            return false;
        }

        // Sanitise keyId to an 8-bit value.
        var keyId = parsedMessage.keyId & 0xff;

        // Get sender key.
        var senderKey;
        if (parsedMessage.keys.length  > 0) {
            var isOwnMessage = (sender === this.ownHandle);
            var otherHandle = isOwnMessage ? parsedMessage.recipients[0] : sender;
            // Decrypt message key(s) and update their local cache.
            parsedMessage.keys[0] = this._decryptKeysFor(parsedMessage.keys[0],
                                                         parsedMessage.nonce,
                                                         otherHandle,
                                                         isOwnMessage);
            senderKey = parsedMessage.keys[0][0];

            if (!this.participantKeys[sender]) {
                this.participantKeys[sender] = {};
            }
            this.participantKeys[sender][keyId] = senderKey;
            if (parsedMessage.keys[0].length > 1) {
                var previousKeyId = (parsedMessage.keyId - 1) & 0xff;
                // Bail out on inconsistent information.
                if (this.participantKeys[sender][previousKeyId]
                        && (this.participantKeys[sender][previousKeyId] !== parsedMessage.keys[0][1])) {
                    logger.error("Mismatching statement on sender's previous key.");

                    return false;
                }
                this.participantKeys[sender][previousKeyId] = parsedMessage.keys[0][1];
            }
        }
        else {
            if (this.participantKeys[sender] && this.participantKeys[sender][keyId]) {
                senderKey = this.participantKeys[sender][keyId];
            }
            else {
                logger.error('Encryption key for message from ' + sender
                             + ' with ID ' + keyId + ' unavailable.');

                return false;
            }
        }

        // Decrypt message payload.
        var cleartext = ns._symmetricDecryptMessage(parsedMessage.payload,
                                                    senderKey,
                                                    parsedMessage.nonce);

        // Bail out if decryption failed.
        if (cleartext === false) {
            return false;
        }

        var result = {
            sender: sender,
            type: parsedMessage.type,
            payload: cleartext
        };

        return result;
    };

}());
