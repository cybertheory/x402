// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {ERC1363} from "@openzeppelin/contracts/token/ERC20/extensions/ERC1363.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import {ERC20Pausable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Pausable.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @custom:security-contact dev@x402instant.com
contract Token is ERC20, ERC20Burnable, ERC20Pausable, Ownable, ERC1363, ERC20Permit {
    uint256 public maxSupply;
    
    constructor(
        string memory name,
        string memory symbol,
        uint8 decimals,
        uint256 initialSupply,
        uint256 _maxSupply
    )
        ERC20(name, symbol)
        Ownable(msg.sender)
        ERC20Permit(name)
    {
        maxSupply = _maxSupply;
        if (initialSupply > 0) {
            _mint(msg.sender, initialSupply);
        }
    }

    function pause() public onlyOwner {
        _pause();
    }

    function unpause() public onlyOwner {
        _unpause();
    }

    function mint(address to, uint256 amount) public onlyOwner {
        require(maxSupply == 0 || totalSupply() + amount <= maxSupply, "Token: exceeds max supply");
        _mint(to, amount);
    }

    // The following functions are overrides required by Solidity.

    function _update(address from, address to, uint256 value)
        internal
        override(ERC20, ERC20Pausable)
    {
        super._update(from, to, value);
    }
}

