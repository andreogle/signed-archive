import { type Address, encodePacked, type Hex, isAddressEqual, keccak256, recoverMessageAddress } from 'viem';

export interface SignedDatum {
  airnode: Address;
  templateId: Hex;
  timestamp: string;
  encodedValue: Hex;
  signature: Hex;
}

const isHex = (value: unknown, bytes: number): value is Hex =>
  typeof value === 'string' && value.length === 2 + bytes * 2 && /^0x[0-9a-fA-F]*$/.test(value);

// The response is untrusted input: anything that doesn't have the exact shape is dropped. Timestamps must
// be safe integers: the store keeps them as numbers, and a rounded timestamp would no longer match its signature.
export function toSignedDatum(value: unknown): SignedDatum | null {
  if (typeof value !== 'object' || value === null) return null;
  const { airnode, templateId, timestamp, encodedValue, signature } = value as Record<string, unknown>;
  if (
    !isHex(airnode, 20) ||
    !isHex(templateId, 32) ||
    typeof timestamp !== 'string' ||
    !/^\d{1,16}$/.test(timestamp) ||
    !Number.isSafeInteger(Number(timestamp)) ||
    !isHex(encodedValue, 32) ||
    !isHex(signature, 65)
  ) {
    return null;
  }
  return { airnode, templateId, timestamp, encodedValue, signature };
}

// Half the secp256k1 group order. OpenZeppelin's ECDSA, which Api3ServerV1 uses, rejects a larger `s`.
const MAX_S = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;

// Same check as Api3ServerV1: EIP-191 over keccak256(templateId, timestamp, data). OEV data uses
// the same scheme; the Signed API already serves it under the OEV template ID. Like the contract, it refuses the
// malleable forms of a signature (high `s`, or `v` other than 27 or 28) that viem would accept: anyone can derive them
// from a public record, and a stored copy the contract rejects is no evidence of what can go on-chain.
export async function hasValidSignature(datum: SignedDatum): Promise<boolean> {
  try {
    const s = BigInt(`0x${datum.signature.slice(66, 130)}`);
    const v = datum.signature.slice(130).toLowerCase();
    if (s > MAX_S || (v !== '1b' && v !== '1c')) return false;
    const hash = keccak256(
      encodePacked(['bytes32', 'uint256', 'bytes'], [datum.templateId, BigInt(datum.timestamp), datum.encodedValue])
    );
    const signer = await recoverMessageAddress({ message: { raw: hash }, signature: datum.signature });
    return isAddressEqual(signer, datum.airnode);
  } catch {
    return false;
  }
}
