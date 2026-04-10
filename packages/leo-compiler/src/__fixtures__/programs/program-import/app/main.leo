import utils.aleo;

program app.aleo {
  @noupgrade
  constructor() {}

  fn run(x: u32) -> u32 {
    return utils.aleo::double(x);
  }
}
