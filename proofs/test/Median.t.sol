// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import "@api3/contracts/api3-server-v1/aggregation/Median.sol";

// Fuzz tests of API3's Median.sol, the aggregation Api3ServerV1 uses for beacon sets, read unchanged from
// the @api3/contracts package. Lengths 1 to 21 cover both the sorting network (up to 9) and quickselect (10 and up).
contract MedianTest is Median {
    /// The overflow-safe average is exactly (x + y) / 2 rounded toward zero for int224 values, the type beacons
    /// store. Solidity's `/` rounds toward zero and the sum of two int224 values cannot overflow int256, so the right
    /// side is a trustworthy reference.
    function testFuzz_averageIsTheTruncatedMean(int224 x, int224 y) public pure {
        assert(median(array2(x, y)) == (int256(x) + int256(y)) / 2);
    }

    /// For any int256 pair, even where x + y would overflow, the average lies between the two inputs.
    function testFuzz_averageStaysBetweenItsInputs(int256 x, int256 y) public pure {
        int256 m = median(array2(x, y));
        assert(m >= (x < y ? x : y) && m <= (x < y ? y : x));
    }

    /// Every length from 1 to 21, so both the sorting network (up to 9) and quickselect (10 and up) are covered, is
    /// compared with a plain reference: sort a copy, then take the middle value or the truncated mean of the two.
    function testFuzz_medianMatchesReference(int224[21] memory raw, uint8 lengthSeed) public pure {
        uint256 length = 1 + (uint256(lengthSeed) % 21);
        int256[] memory values = new int256[](length);
        int256[] memory sorted = new int256[](length);
        for (uint256 i = 0; i < length; i++) {
            values[i] = raw[i];
            sorted[i] = raw[i];
        }
        insertionSort(sorted);
        int256 expected = length % 2 == 1
            ? sorted[length / 2]
            : (sorted[length / 2 - 1] + sorted[length / 2]) / 2;
        assert(median(values) == expected);
    }

    /// The median does not depend on the order of the inputs: reversing them changes nothing.
    function testFuzz_medianIgnoresOrder(int256[21] memory raw, uint8 lengthSeed) public pure {
        uint256 length = 1 + (uint256(lengthSeed) % 21);
        int256[] memory forward = new int256[](length);
        int256[] memory backward = new int256[](length);
        for (uint256 i = 0; i < length; i++) {
            forward[i] = raw[i];
            backward[length - 1 - i] = raw[i];
        }
        assert(median(forward) == median(backward));
    }

    /// Many equal values are where partition-based selection usually goes wrong.
    function testFuzz_medianWithFewDistinctValues(uint8[21] memory raw, uint8 lengthSeed) public pure {
        uint256 length = 10 + (uint256(lengthSeed) % 12);
        int256[] memory values = new int256[](length);
        for (uint256 i = 0; i < length; i++) values[i] = int256(uint256(raw[i] % 3));
        assertIsMedian(values);
    }

    // --- Helpers ---

    function array2(int256 x, int256 y) private pure returns (int256[] memory values) {
        values = new int256[](2);
        (values[0], values[1]) = (x, y);
    }

    /// m is a median of the inputs when at most half of them are below it and at most half above it. For an odd count
    /// it must also be one of the inputs. median() reorders its argument, so the inputs are copied first.
    function assertIsMedian(int256[] memory values) private pure {
        uint256 length = values.length;
        int256[] memory copy = new int256[](length);
        for (uint256 i = 0; i < length; i++) copy[i] = values[i];
        int256 m = median(copy);
        uint256 below;
        uint256 above;
        bool isInput;
        for (uint256 i = 0; i < length; i++) {
            if (values[i] < m) below++;
            if (values[i] > m) above++;
            if (values[i] == m) isInput = true;
        }
        assert(below <= length / 2 && above <= length / 2);
        if (length % 2 == 1) assert(isInput);
    }

    function insertionSort(int256[] memory values) private pure {
        for (uint256 i = 1; i < values.length; i++) {
            int256 key = values[i];
            uint256 j = i;
            while (j > 0 && values[j - 1] > key) {
                values[j] = values[j - 1];
                j--;
            }
            values[j] = key;
        }
    }
}
