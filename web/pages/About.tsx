export function AboutPage() {
  return (
    <>
      <section className="intro">
        <h1>Check it yourself</h1>
        <p>
          API3's data providers sign every price they publish. This archive stores those signed records exactly as
          published, so the history is evidence anyone can re-check, not data you have to trust.
        </p>
      </section>

      <ol className="steps">
        <li>
          <strong>Every record is signed.</strong> The provider signs the feed's template ID, the time and the value.
          Changing any of them breaks the signature.
        </li>
        <li>
          <strong>Your browser re-checks it.</strong> The signature column in the explorer is computed on the page, not
          by the server, using the same check API3's on-chain contract runs.
        </li>
        <li>
          <strong>Take the proof with you.</strong> “Download proof” saves the raw signed records, so anyone can verify
          them later with any Ethereum library.
        </li>
      </ol>

      <section className="card">
        <h2>How a signature is checked</h2>
        <p className="muted">
          The message is <code>keccak256(templateId, timestamp, encodedValue)</code>, packed as bytes32, uint256 and
          bytes. The provider signs it with EIP-191 (<code>personal_sign</code>), so recovering the signer from the
          signature must give the provider's airnode address. This is the check <code>Api3ServerV1</code> runs before it
          accepts a price on-chain.
        </p>
        <h2>Base and OEV data</h2>
        <p className="muted">
          Base data is public and delayed about 15 seconds. OEV data is fresher and signed under a separate template ID,{' '}
          <code>keccak256(templateId)</code>, for API3's OEV auctions. Both are archived.
        </p>
      </section>
    </>
  );
}
