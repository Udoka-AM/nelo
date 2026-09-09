use anchor_lang::prelude::*;

declare_id!("yzDTDHq5cjLW1QZkfH1UEggMtLe8SaNr3MXQgRwpzhu");

#[program]
pub mod nelo_vault {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        msg!("Greetings from: {:?}", ctx.program_id);
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Initialize {}
