program nft_registry.aleo {
    @noupgrade
    constructor() {}

    struct NftMetadata {
        collection_id: u64,
        serial: u64,
        uri_hash: field,
    }

    record Nft {
        owner: address,
        metadata: NftMetadata,
    }

    /// Collection admin address.
    mapping collection_admin: u64 => address;

    /// Current mint count per collection.
    mapping collection_supply: u64 => u64;

    /// Create a new NFT collection. The signer becomes the admin.
    fn create_collection(public collection_id: u64) -> Final {
        let admin: address = self.signer;
        return final {
            collection_admin.set(collection_id, admin);
            collection_supply.set(collection_id, 0u64);
        };
    }

    /// Mint an NFT. Only the collection admin can mint.
    fn mint_nft(
        receiver: address,
        public collection_id: u64,
        serial: u64,
        uri_hash: field,
    ) -> (Nft, Final) {
        let nft: Nft = Nft {
            owner: receiver,
            metadata: NftMetadata {
                collection_id: collection_id,
                serial: serial,
                uri_hash: uri_hash,
            },
        };
        let minter: address = self.signer;
        return (nft, final {
            let admin: address = collection_admin.get(collection_id);
            assert_eq(admin, minter);
            let supply: u64 = collection_supply.get(collection_id);
            collection_supply.set(collection_id, supply + 1u64);
        });
    }

    /// Transfer an NFT to a new owner. Pure record operation — no finalize needed.
    fn transfer_nft(nft: Nft, receiver: address) -> Nft {
        return Nft {
            owner: receiver,
            metadata: nft.metadata,
        };
    }
}
