program utils.aleo {
  @noupgrade
  constructor() {}

  fn double(x: u32) -> u32 {
    return x * 2u32;
  }
}
