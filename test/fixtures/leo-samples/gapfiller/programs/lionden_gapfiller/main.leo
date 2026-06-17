// Hand-authored gap-filler for surfaces leo-samples does not exercise:
// primitive serializer round-trips (+ TransitionInputError on bad input),
// hashing/crypto codegen+execution, and private outputs for the decryption
// error surface (RecordDecryptionKeyError / Local{Record,Value}DecryptionError).
program lionden_gapfiller.aleo {
    record SecretNote {
        owner: address,
        amount: u64,
        secret: field,
    }

    // ---- primitive echoes: serializer round-trips + bad-input rejection ------
    fn echo_addr(x: address) -> address { return x; }
    fn echo_field(x: field) -> field { return x; }
    fn echo_group(x: group) -> group { return x; }
    fn echo_scalar(x: scalar) -> scalar { return x; }
    fn echo_bool(x: bool) -> bool { return x; }
    fn echo_u8(x: u8) -> u8 { return x; }
    fn echo_u16(x: u16) -> u16 { return x; }
    fn echo_u32(x: u32) -> u32 { return x; }
    fn echo_u64(x: u64) -> u64 { return x; }
    fn echo_u128(x: u128) -> u128 { return x; }
    fn echo_i8(x: i8) -> i8 { return x; }
    fn echo_i16(x: i16) -> i16 { return x; }
    fn echo_i32(x: i32) -> i32 { return x; }
    fn echo_i64(x: i64) -> i64 { return x; }
    fn echo_i128(x: i128) -> i128 { return x; }

    // ---- hashing / crypto: codegen + execution -------------------------------
    fn hash_bhp(x: field) -> field {
        return BHP256::hash_to_field(x);
    }
    fn hash_poseidon(x: field) -> field {
        return Poseidon2::hash_to_field(x);
    }
    fn hash_pedersen(x: u32) -> field {
        // Pedersen64 hashes inputs of < 64 bits (or bool); u32 fits.
        return Pedersen64::hash_to_field(x);
    }

    // ---- private outputs: decryption-error surface ---------------------------
    // Returns a private record (EncryptedRecord) and a private value
    // (EncryptedValue) so the generated bindings expose `.decrypt(...)`.
    fn mint_secret(public amount: u64, secret: field) -> (SecretNote, field) {
        let note: SecretNote = SecretNote { owner: self.signer, amount, secret };
        return (note, secret);
    }

    @noupgrade
    constructor() {}
}
