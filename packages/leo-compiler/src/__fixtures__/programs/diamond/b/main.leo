import d.aleo;

program b.aleo {
  @noupgrade
  constructor() {}

  fn via_b() -> u32 {
    return d.aleo::base();
  }
}
