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

// Same check as Api3ServerV1: EIP-191 over keccak256(templateId, timestamp, data). OEV data uses
// the same scheme; the Signed API already serves it under the OEV template ID.
export async function hasValidSignature(datum: SignedDatum): Promise<boolean> {
  const hash = keccak256(
    encodePacked(['bytes32', 'uint256', 'bytes'], [datum.templateId, BigInt(datum.timestamp), datum.encodedValue])
  );
  try {
    const signer = await recoverMessageAddress({ message: { raw: hash }, signature: datum.signature });
    return isAddressEqual(signer, datum.airnode);
  } catch {
    return false;
  }
}
